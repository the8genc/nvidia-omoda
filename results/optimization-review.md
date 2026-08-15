<!-- Concern: the prioritized real-time optimization findings for the pipeline (the path to reach goal R3) | Non-concern: correctness of any stage (its own verdict) | IO: none -->

# Optimization review — path to real-time (reach R3)

**Verdict: the architecture is the bottleneck, not the models.** Today each stage is a separate
`docker run` that reloads its model; seg/depth are invoked once per frame. Overhead dwarfs inference
~100–1000×.

| # | Area | Impact | Change |
|---|------|--------|--------|
| 1 | Container/model reload | **HIGH (dominant)** | One persistent process loads SegFormer+Depth+YOLO once; frame loop + batching. Current ~15–40 s reload per stage per call vs tens of ms inference. |
| 2 | Render + parallelism | **HIGH** | Drop matplotlib 3D scatter (seconds/frame) → GPU/projection rasterizer (tessellated surface, in progress). Overlap seg/depth/detect via CUDA streams. |
| 3 | Redundant recompute | **HIGH (stream)** | EMA/rolling static mask + depth anchor instead of full-window recompute each frame; honor the existing `.npy` cache. |
| 4 | Downsampling | **MED** | Aspect-preserving downscale for SegFormer (never square — fixed constraint); argmax on coarse logits then nearest-upsample the class-id map; depth/pcd at the stride-4 working grid. |
| 5 | Simplification | **LOW–MED** | float32 not float64; `cv2.applyColorMap` not matplotlib for depth viz; scope the cuDNN disable narrowly (global-off slows all convs); de-dup `back_project`/anchor code shared across scripts. |

**Bottom line:** a persistent multi-model server + GPU renderer + EMA anchor state converts the pipeline
from "tens of seconds per stage per frame" to a genuinely GPU-bound real-time loop. This is the concrete
build for the real-time reach goal; deferred until the twin concept (Stage D) is proven, per
don't-optimize-prematurely.
