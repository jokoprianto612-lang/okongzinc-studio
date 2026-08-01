"""
LongCat-Video worker on Modal — text-to-video, image-to-video, continuation.

meituan-longcat/LongCat-Video is a 13.6B open-weights video model. Facts
verified against the upstream repo on 2026-08-01:

  * weights total ~83 GB  (DiT 6 shards ~50 GB + UMT5 text encoder ~25 GB)
  * torch 2.6.0 + CUDA 12.4 + flash-attn 2.7.4.post1
  * pipeline: 480p/93-frame base (50 steps) -> optional distilled pass
    (16 steps via cfg_step_lora) -> optional 720p refinement (refinement_lora
    + block sparse attention), 15fps before refine, 30fps after
  * natively pretrained on video-continuation, so clips extend without the
    colour drift of naive frame-chaining

Why Modal: 83 GB of weights and an 80 GB-class GPU. This is not laptop work.

Deploy:

    pip install modal
    modal setup
    modal deploy modal/longcat_app.py

Modal prints a web endpoint. Put it in the studio's .env:

    MODAL_LONGCAT_URL=https://<workspace>--okongzinc-longcat-generate.modal.run
    MODAL_LONGCAT_TOKEN=<same value as the modal secret, optional>

Contract with server/src/providers/modalLongcat.ts:

    POST { task, prompt, negative_prompt?, image_base64?, resolution,
           num_frames?, use_distill?, refine?, seed? }
    ->   { video_base64, mime_type, filename, frames, fps }

Cost warning: an H100 is billed per second and a refined 720p clip takes
minutes. `scaledown_window` keeps the container warm briefly between requests
so back-to-back generations skip the (very long) cold start.
"""

import base64
import io
import os
import tempfile

import modal

APP_NAME = "okongzinc-longcat"
MODEL_REPO = "meituan-longcat/LongCat-Video"
WEIGHTS_DIR = "/weights/LongCat-Video"

# ---------------------------------------------------------------------------
# Image
# ---------------------------------------------------------------------------
# flash-attn compiles against the CUDA toolkit, so the devel image is required
# (nvcc must exist at build time) — the runtime image is not enough.
longcat_image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.4.1-devel-ubuntu22.04",
        add_python="3.10",
    )
    .apt_install("git", "build-essential", "ffmpeg", "libgl1", "libglib2.0-0")
    .env(
        {
            "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True",
            "HF_HOME": "/cache/huggingface",
            "TOKENIZERS_PARALLELISM": "false",
        }
    )
    .pip_install(
        "torch==2.6.0",
        "torchvision==0.21.0",
        "torchaudio==2.6.0",
        index_url="https://download.pytorch.org/whl/cu124",
    )
    .pip_install("ninja", "psutil", "packaging", "wheel")
    # Building flash-attn from source takes a long time; the prebuilt wheel
    # matches torch 2.6 + cu124 and is what upstream pins.
    .pip_install("flash_attn==2.7.4.post1")
    .pip_install(
        "numpy==1.26.4",
        "transformers==4.41.0",
        "diffusers==0.35.1",
        "loguru==0.7.2",
        "einops==0.8.0",
        "ftfy==6.2.0",
        "av==12.0.0",
        "opencv-python==4.9.0.80",
        "imageio==2.37.0",
        "imageio-ffmpeg==0.6.0",
        "pyarrow==20.0.0",
        "huggingface_hub[cli]",
        "fastapi[standard]",
        "pillow",
    )
    .run_commands(
        "git clone --single-branch --branch main "
        "https://github.com/meituan-longcat/LongCat-Video /opt/LongCat-Video"
    )
    # The repo is imported as a package from its own directory.
    .env({"PYTHONPATH": "/opt/LongCat-Video"})
)

app = modal.App(APP_NAME)

# 83 GB of weights: cache on a volume so only the first cold start downloads.
weights = modal.Volume.from_name("okongzinc-longcat-weights", create_if_missing=True)
cache = modal.Volume.from_name("okongzinc-longcat-cache", create_if_missing=True)


@app.function(
    image=longcat_image,
    volumes={"/weights": weights, "/cache": cache},
    timeout=7200,
)
def download_weights():
    """One-time weight fetch. Run before the first generate call:

        modal run modal/longcat_app.py::download_weights
    """
    from huggingface_hub import snapshot_download

    if os.path.exists(os.path.join(WEIGHTS_DIR, "dit")):
        print("weights already present, skipping")
        return

    print(f"downloading {MODEL_REPO} (~83 GB) …")
    snapshot_download(repo_id=MODEL_REPO, local_dir=WEIGHTS_DIR)
    weights.commit()
    print("done")


@app.cls(
    image=longcat_image,
    gpu="H100",
    volumes={"/weights": weights, "/cache": cache},
    timeout=3600,
    scaledown_window=600,
    secrets=[modal.Secret.from_name("okongzinc-longcat", required_keys=[])],
)
class LongCat:
    """Holds the loaded pipeline so warm requests skip a multi-minute init."""

    @modal.enter()
    def load(self):
        import torch
        from transformers import AutoTokenizer, UMT5EncoderModel

        from longcat_video.pipeline_longcat_video import LongCatVideoPipeline
        from longcat_video.modules.autoencoder_kl_wan import AutoencoderKLWan
        from longcat_video.modules.longcat_video_dit import LongCatVideoTransformer3DModel
        from longcat_video.modules.scheduling_flow_match_euler_discrete import (
            FlowMatchEulerDiscreteScheduler,
        )

        if not os.path.exists(os.path.join(WEIGHTS_DIR, "dit")):
            raise RuntimeError(
                "weights missing — run: "
                "modal run modal/longcat_app.py::download_weights"
            )

        self.torch = torch
        dtype = torch.bfloat16

        tokenizer = AutoTokenizer.from_pretrained(f"{WEIGHTS_DIR}/tokenizer")
        text_encoder = UMT5EncoderModel.from_pretrained(
            f"{WEIGHTS_DIR}/text_encoder", torch_dtype=dtype
        )
        vae = AutoencoderKLWan.from_pretrained(f"{WEIGHTS_DIR}/vae", torch_dtype=torch.float32)
        dit = LongCatVideoTransformer3DModel.from_pretrained(
            f"{WEIGHTS_DIR}/dit", torch_dtype=dtype
        )
        scheduler = FlowMatchEulerDiscreteScheduler(shift=5.0)

        self.pipe = LongCatVideoPipeline(
            tokenizer=tokenizer,
            text_encoder=text_encoder,
            vae=vae,
            scheduler=scheduler,
            dit=dit,
        )
        self.pipe.to("cuda")
        self.checkpoint_dir = WEIGHTS_DIR

    # -- helpers ---------------------------------------------------------

    def _check_auth(self, authorization: str | None) -> None:
        expected = os.environ.get("LONGCAT_TOKEN", "")
        if not expected:
            return  # no token configured -> endpoint is open
        provided = (authorization or "").removeprefix("Bearer ").strip()
        if provided != expected:
            from fastapi import HTTPException

            raise HTTPException(status_code=401, detail="invalid bearer token")

    def _load_lora(self, name: str) -> None:
        path = os.path.join(self.checkpoint_dir, "lora", f"{name}.safetensors")
        self.pipe.dit.load_lora(path, name)
        self.pipe.dit.enable_loras([name])

    def _write_mp4(self, frames, fps: int) -> bytes:
        """frames: float array in [0,1], shape (T, H, W, C)."""
        import numpy as np
        from torchvision.io import write_video

        tensor = self.torch.from_numpy(np.array(frames))
        tensor = (tensor * 255).clamp(0, 255).to(self.torch.uint8)

        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as fh:
            out_path = fh.name
        write_video(out_path, tensor, fps=fps, video_codec="libx264", options={"crf": "18"})
        with open(out_path, "rb") as fh:
            data = fh.read()
        os.unlink(out_path)
        return data

    # -- endpoint --------------------------------------------------------

    @modal.fastapi_endpoint(method="POST", docs=True)
    def generate(self, payload: dict, authorization: str | None = None):
        from fastapi import HTTPException
        from PIL import Image

        self._check_auth(authorization)

        task = payload.get("task", "t2v")
        prompt = (payload.get("prompt") or "").strip()
        if not prompt:
            raise HTTPException(status_code=400, detail="prompt is required")

        negative_prompt = payload.get("negative_prompt") or ""
        resolution = payload.get("resolution", "480p")
        num_frames = int(payload.get("num_frames", 93))
        use_distill = bool(payload.get("use_distill", False))
        refine = bool(payload.get("refine", False))
        seed = int(payload.get("seed", 42))

        height, width = (480, 832) if resolution == "480p" else (720, 1280)

        generator = self.torch.Generator(device="cuda")
        generator.manual_seed(seed)

        source_image = None
        if payload.get("image_base64"):
            try:
                raw = base64.b64decode(payload["image_base64"])
                source_image = Image.open(io.BytesIO(raw)).convert("RGB")
            except Exception as exc:
                raise HTTPException(
                    status_code=400, detail=f"could not decode image: {exc}"
                ) from exc

        if task in {"i2v", "continuation"} and source_image is None:
            raise HTTPException(
                status_code=400, detail=f"task '{task}' requires image_base64"
            )

        # Distilled sampling uses cfg_step_lora at 16 steps with guidance 1.0.
        if use_distill:
            self._load_lora("cfg_step_lora")
            steps, guidance = 16, 1.0
        else:
            steps, guidance = 50, 4.0

        try:
            if task == "i2v":
                output = self.pipe.generate_i2v(
                    prompt=prompt,
                    negative_prompt=negative_prompt or None,
                    image=source_image,
                    height=height,
                    width=width,
                    num_frames=num_frames,
                    num_inference_steps=steps,
                    guidance_scale=guidance,
                    use_distill=use_distill,
                    generator=generator,
                )[0]
            elif task == "continuation":
                output = self.pipe.generate_video_continuation(
                    prompt=prompt,
                    negative_prompt=negative_prompt or None,
                    image=source_image,
                    height=height,
                    width=width,
                    num_frames=num_frames,
                    num_inference_steps=steps,
                    guidance_scale=guidance,
                    use_distill=use_distill,
                    generator=generator,
                )[0]
            else:
                output = self.pipe.generate_t2v(
                    prompt=prompt,
                    negative_prompt=negative_prompt or None,
                    height=height,
                    width=width,
                    num_frames=num_frames,
                    num_inference_steps=steps,
                    guidance_scale=guidance,
                    use_distill=use_distill,
                    generator=generator,
                )[0]
        finally:
            if use_distill:
                self.pipe.dit.disable_all_loras()

        fps = 15

        # 720p refinement: feed stage-1 frames back through refinement_lora with
        # block sparse attention. This is the slow path.
        if refine:
            import numpy as np

            stage1 = [
                Image.fromarray((output[i] * 255).astype(np.uint8))
                for i in range(output.shape[0])
            ]
            self._load_lora("refinement_lora")
            self.pipe.dit.enable_bsa()
            try:
                output = self.pipe.generate_refine(
                    prompt=prompt,
                    stage1_video=stage1,
                    num_inference_steps=50,
                    generator=generator,
                    spatial_refine_only=False,
                )[0]
                fps = 30
            finally:
                self.pipe.dit.disable_all_loras()
                self.pipe.dit.disable_bsa()
                self.torch.cuda.empty_cache()

        video_bytes = self._write_mp4(output, fps)

        return {
            "video_base64": base64.b64encode(video_bytes).decode(),
            "mime_type": "video/mp4",
            "filename": f"longcat_{task}.mp4",
            "frames": int(getattr(output, "shape", [num_frames])[0]),
            "fps": fps,
            "bytes": len(video_bytes),
        }


@app.local_entrypoint()
def main():
    print(
        "1) modal run modal/longcat_app.py::download_weights   (~83 GB, once)\n"
        "2) modal deploy modal/longcat_app.py\n"
        "3) copy the printed endpoint into MODAL_LONGCAT_URL in .env"
    )
