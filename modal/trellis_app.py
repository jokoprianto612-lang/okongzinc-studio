"""
TRELLIS.2 image-to-3D worker on Modal.

Why this is remote: microsoft/TRELLIS.2 requires an NVIDIA GPU with at least
24 GB of VRAM (upstream README states it is verified on A100 and H100, CUDA
12.4). That does not fit on a typical laptop, so the studio calls this Modal
web endpoint instead of running the model locally.

Deploy:

    pip install modal
    modal setup
    modal deploy modal/trellis_app.py

Modal prints a web endpoint URL. Put it in the studio's .env:

    MODAL_TRELLIS_URL=https://<workspace>--okongzinc-trellis-generate.modal.run
    MODAL_TRELLIS_TOKEN=<the same value you set in the modal secret, optional>

Contract with server/src/providers/modalTrellis.ts:

    POST { image_base64, mime_type, seed? }  ->  { glb_base64, filename }

Cost note: an A100 is billed per second while the container is warm.
`scaledown_window` keeps it alive briefly between requests so back-to-back
generations skip the cold start, then it shuts down on its own.
"""

import base64
import io
import os

import modal

APP_NAME = "okongzinc-trellis"

# ---------------------------------------------------------------------------
# Image
# ---------------------------------------------------------------------------
# TRELLIS.2 compiles CUDA extensions at install time, so we need the devel
# CUDA image (nvcc present), not just the runtime one.
trellis_image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.4.1-devel-ubuntu22.04",
        add_python="3.11",
    )
    .apt_install("git", "build-essential", "libgl1", "libglib2.0-0", "ffmpeg")
    .env(
        {
            # TRELLIS reads these at import time.
            "ATTN_BACKEND": "flash-attn",
            "SPCONV_ALGO": "native",
            "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True",
            "HF_HOME": "/cache/huggingface",
        }
    )
    .pip_install(
        "torch==2.6.0",
        "torchvision==0.21.0",
        index_url="https://download.pytorch.org/whl/cu124",
    )
    .pip_install(
        "fastapi[standard]",
        "pillow",
        "numpy",
        "huggingface_hub",
        "transformers",
        "safetensors",
        "einops",
        "trimesh",
    )
    # Clone upstream at deploy time. Pin a commit here once you have a known
    # good revision — a moving main branch will eventually break the build.
    .run_commands(
        "git clone --recursive https://github.com/microsoft/TRELLIS.2.git /opt/TRELLIS2",
        "cd /opt/TRELLIS2 && pip install -e . || true",
    )
)

app = modal.App(APP_NAME)

# Model weights are large; cache them on a volume so only the first cold start
# pays the download.
cache = modal.Volume.from_name("okongzinc-trellis-cache", create_if_missing=True)


@app.cls(
    image=trellis_image,
    gpu="A100-40GB",
    volumes={"/cache": cache},
    timeout=900,
    scaledown_window=300,
    # Optional bearer token. Create with:
    #   modal secret create okongzinc-trellis TRELLIS_TOKEN=<value>
    secrets=[modal.Secret.from_name("okongzinc-trellis", required_keys=[])],
)
class Trellis:
    """Holds the loaded pipeline so warm requests skip model init."""

    @modal.enter()
    def load(self):
        import torch
        from trellis2.pipelines import Trellis2ImageTo3DPipeline

        self.torch = torch
        self.pipeline = Trellis2ImageTo3DPipeline.from_pretrained(
            "microsoft/TRELLIS2-image-large"
        )
        self.pipeline.cuda()

    def _check_auth(self, authorization: str | None) -> None:
        expected = os.environ.get("TRELLIS_TOKEN", "")
        if not expected:
            return  # no token configured -> endpoint is open
        provided = (authorization or "").removeprefix("Bearer ").strip()
        if provided != expected:
            from fastapi import HTTPException

            raise HTTPException(status_code=401, detail="invalid bearer token")

    @modal.fastapi_endpoint(method="POST", docs=True)
    def generate(self, payload: dict, authorization: str | None = None):
        """image_base64 -> a .glb mesh, returned as base64."""
        from fastapi import HTTPException
        from PIL import Image

        self._check_auth(authorization)

        raw_b64 = payload.get("image_base64")
        if not raw_b64:
            raise HTTPException(status_code=400, detail="image_base64 is required")

        seed = int(payload.get("seed", 1))

        try:
            image_bytes = base64.b64decode(raw_b64)
            image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        except Exception as exc:
            raise HTTPException(
                status_code=400, detail=f"could not decode image: {exc}"
            ) from exc

        outputs = self.pipeline.run(image, seed=seed)

        # The pipeline returns a mesh object; export it to a binary glTF.
        mesh = outputs["mesh"][0] if isinstance(outputs, dict) else outputs
        glb_path = "/tmp/output.glb"
        if hasattr(mesh, "export"):
            mesh.export(glb_path)
        else:
            from trellis2.utils import postprocessing_utils

            glb = postprocessing_utils.to_glb(
                outputs["gaussian"][0], outputs["mesh"][0]
            )
            glb.export(glb_path)

        with open(glb_path, "rb") as fh:
            glb_bytes = fh.read()

        return {
            "glb_base64": base64.b64encode(glb_bytes).decode(),
            "filename": "trellis2.glb",
            "bytes": len(glb_bytes),
        }


@app.local_entrypoint()
def main():
    print(
        "Deploy with:  modal deploy modal/trellis_app.py\n"
        "Then copy the printed web endpoint URL into MODAL_TRELLIS_URL in .env"
    )
