<!-- Concern: the two pipeline corrections after reopening the seg + fixing the point-cloud projection | Non-concern: the webapp or the original single-frame verdicts | IO: none -->

# Pipeline fixes — reopened seg + projection bug

## 1. Segmentation, reopened (the values doc was right — a noisy result must not be accepted)
Bake-off of 6 models (3 architectures × 2 training sets) on the Shibuya crowd frame. Winner:
**`facebook/mask2former-swin-large-cityscapes-semantic`** — it segments the dense crowds as **person
(18.7% / 20.2%)** vs the SegFormer-B0 baseline's **0.03%**, with clean road / sidewalk / vehicles /
buildings. The Cityscapes *architecture* wasn't the problem — the *tiny B0 model* was. Ranked:
m2f_city > segb5_city > oneformer_city > segb4_ade > m2f_ade > oneformer_ade (the last reproduces the
baseline failure — crowds buried into sidewalk/tree). Artifacts: `results/segbakeoff/`. **Adopted:
m2f_city is the pipeline's seg model.**

## 2. Point-cloud projection bug (the "looks like noise" / bowl)
Depth-Anything emits **disparity-like** values (larger = nearer ≈ 1/Z). The renderers mapped **Z
linearly** in that value, which hyperbolically **warps a flat road into a bowl**. Fix: invert to true
depth **`Z = 1/(d_norm + 0.05)`** before the pinhole back-projection. Road-planarity residual (RMS
normal to the fitted plane / extent): **0.188 (bowl) → 0.076 (flat sheet)**. A metric model
(Depth-Anything-V2-Outdoor) was better than the bug (0.124) but *worse* than the simple inversion, so no
new model is needed for the fix. Visual: old = U-shaped bowl; new = road is a flat sheet receding to the
horizon, verticals rising away. Artifacts: `results/proj_fix/`. **Adopted in the backend + renders.**

## 3. New primary test video
**Bellevue intersection** (City-of-Bellevue TrafficVideoDataset, 1280×720): clear marked road, a Metro
bus + cars, almost no pedestrians — avoids the Shibuya crowd pathology. A fisheye pole-cam (edge
distortion — the pinhole lift is approximate near borders; undistortion is a research item).
`bellevue_15s.mp4` + `frames_bellevue/`.
