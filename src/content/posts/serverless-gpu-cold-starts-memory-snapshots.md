---
title: "Cutting serverless GPU cold starts from ~40s to ~11s"
description: "Making a free tier viable on Modal: baked model weights, CPU memory snapshots, experimental GPU snapshots, and doing all the expensive work inside the snapshotted enter hook."
pubDatetime: 2026-06-09T00:00:00Z
tags:
  - serverless
  - gpu
  - modal
  - infrastructure
  - ml
---

Diecut Studio runs three models per request — Grounding DINO for detection, SAM 2 for segmentation, Real-ESRGAN for upscaling — and I wanted its personal tier to be free. Free means the GPU has to scale to zero between requests — no container running while nobody's using it — and scale-to-zero means the cold start *is* the product experience: the first user of the hour eats the entire startup cost. On Modal with an A10G, that cost started around **40 seconds**. After the changes below, cold starts settle at **~11 seconds on average** once snapshots are primed — observed across normal usage rather than a controlled benchmark, but consistent enough to change what the app feels like.

## Where 40 seconds goes

A serverless GPU cold start is a stack of waits:

1. **Container scheduling and boot** — out of your hands.
2. **Python imports** — `torch` plus `transformers` is seconds on its own.
3. **Model weights** — downloading (if not cached) and deserializing three models.
4. **GPU transfer** — moving weights into VRAM, the GPU's onboard memory.
5. **CUDA warmup** — context creation and kernel compilation (the GPU compiles the machine code for each operation the first time it runs), paid lazily on the first inference if you don't force it earlier.

Each layer needs a different fix, and the fixes compound.

## Step 0: bake the weights into the image

The downloads are the easiest win: run them at image build time, so the weights live in an image layer instead of behind the Hugging Face CDN.

```python
def _download_models():
    AutoProcessor.from_pretrained("IDEA-Research/grounding-dino-base")
    AutoModelForZeroShotObjectDetection.from_pretrained("IDEA-Research/grounding-dino-base")
    SAM2ImagePredictor.from_pretrained("facebook/sam2-hiera-small", device="cpu")
    # ... Real-ESRGAN weights via RealESRGANer

gpu_image = gpu_image.run_function(_download_models)
```

Two details that matter: the download runs as its *own* image layer, so editing application code doesn't re-trigger it, and the container sets `HF_HUB_OFFLINE=1` / `TRANSFORMERS_OFFLINE=1` so nothing at runtime is tempted to phone home. This removes the network from the cold path — but imports, deserialization, GPU transfer, and CUDA warmup still cost tens of seconds.

## Snapshots: stop redoing work, start restoring it

Modal's memory snapshots change the model: instead of re-executing startup, the platform checkpoints the process after initialization and restores that checkpoint on future cold starts. CPU snapshots capture process memory — imports done, weights deserialized. But for a GPU service that's only half the story: VRAM contents and CUDA state aren't in process memory, so a CPU-only snapshot still leaves you re-loading models onto the GPU after every restore.

The experimental GPU snapshot closes that gap — it captures VRAM and compiled CUDA kernels too:

```python
@app.cls(
    gpu="A10G",
    scaledown_window=180,
    enable_memory_snapshot=True,
    experimental_options={"enable_gpu_snapshot": True},
    env={"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"},
)
class StickerPipeline:
    ...
```

On restore, the models are simply *already in VRAM*. No loading, no transfer, no warmup.

## Front-load everything into the snapshotted hook

Once restores are cheap, the strategy inverts: make the snapshotted initialization do the *maximum* possible work, because you pay for it once and restore it forever. The enter hook loads all three models in parallel, then runs a dummy SAM 2 inference so the lazily-compiled CUDA kernels get captured in the snapshot rather than compiled on the first real request. One subtlety: the warmup must use the same prompt shape production uses (box + center point, `multimask_output=True`) — warm up a different code path and the decoder kernels real requests hit still compile on first use:

```python
@modal.enter(snap=True)
def load_models(self):
    with ThreadPoolExecutor(max_workers=3) as pool:
        for f in [pool.submit(load_esrgan), pool.submit(load_dino), pool.submit(load_sam)]:
            f.result()

    # Warmup: pre-compile CUDA kernels so they're captured in the snapshot.
    # Mirrors the production prompt shape so the decoder path real requests
    # use is the one that gets compiled.
    dummy = np.zeros((64, 64, 3), dtype=np.uint8)
    predictor = load_sam()
    with torch.inference_mode():
        predictor.set_image(dummy)
        predictor.predict(
            box=np.array([[0, 0, 32, 32]]),
            point_coords=np.array([[[16, 16]]]),
            point_labels=np.ones((1, 1), dtype=np.int32),
            multimask_output=True,
        )
        predictor.reset_predictor()
```

The hook logs its own breakdown (`models: …s | warmup: …s | gpu mem: …MB`), which is how you confirm the snapshot is capturing what you think it is.

## What's left, and the caveats

The remaining ~11 seconds is mostly platform: container scheduling plus restoring several gigabytes of snapshot into VRAM. Honest caveats:

- **The first few cold starts are still slow.** Snapshots are created lazily, on early runs — the 40-second path doesn't disappear, it amortizes.
- **The GPU snapshot flag is experimental.** It can change or break; treat it as an optimization, not a load-bearing assumption.
- **Snapshots invalidate on deploy.** Every image or code change pays the slow path again.
- **`scaledown_window` is the cost dial.** 180 seconds keeps a warm container through a burst of clicks but lets it die between visits — that's the free-tier compromise.

The general takeaway for free-tier-viable GPU products: the engineering doesn't go into the request path, it goes into the enter hook. Do everything once, snapshot it, and let restores carry the product.

Code: the Modal app is a single file — GPU class with snapshotted init, plus a CPU-only FastAPI web server that calls it remotely.
