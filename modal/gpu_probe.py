"""
Minimal GPU probe — answers one question: can this Modal account actually run a
GPU container?

Deliberately trivial: a T4 (cheapest GPU tier), no volumes, no model download,
no weights. It allocates one small tensor, reads back CUDA properties, and
exits. Cost is a couple of seconds of T4 time.

Run:
    modal run modal/gpu_probe.py

If the account has no GPU entitlement, this fails at scheduling with a quota /
billing error rather than burning anything.
"""

import modal

probe_image = modal.Image.debian_slim(python_version="3.11").pip_install(
    "torch==2.6.0",
    index_url="https://download.pytorch.org/whl/cu124",
)

app = modal.App("okongzinc-gpu-probe")


@app.function(image=probe_image, gpu="T4", timeout=300)
def probe() -> dict:
    import torch

    if not torch.cuda.is_available():
        return {"cuda": False, "note": "container started but CUDA is unavailable"}

    idx = torch.cuda.current_device()
    props = torch.cuda.get_device_properties(idx)

    # Touch the GPU for real — a driver that reports properties but cannot
    # allocate would otherwise pass a properties-only check.
    x = torch.randn(2048, 2048, device="cuda")
    y = (x @ x.T).sum().item()

    return {
        "cuda": True,
        "device": str(props.name),
        "vram_gb": round(props.total_memory / 1024**3, 1),
        "capability": f"{props.major}.{props.minor}",
        # torch.__version__ is a TorchVersion (str subclass) — pickling it would
        # require torch on the CALLER too, which fails with DeserializationError.
        # Every value returned here must be a plain builtin.
        "torch": str(torch.__version__),
        "matmul_ok": bool(y == y),  # False only if NaN
    }


@app.local_entrypoint()
def main():
    result = probe.remote()
    print("\nGPU PROBE RESULT")
    for k, v in result.items():
        print(f"  {k:<12} {v}")
