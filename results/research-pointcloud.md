<!-- Concern: actionable findings from the depth->point-cloud SOTA research (2026) | Non-concern: implementation or the fisheye-specific research (its own note) | IO: none -->

# Depth → point-cloud research (2026) — actionable findings

## Back-projection (the geometric core)
Depth-Anything relative = **affine-invariant inverse depth**: `D = a·(1/Z) + b` (unknown scale **and
shift**). For any plane, true inverse depth is affine in pixels (`1/Z = α·u+β·v+γ`) — which is why
disparity is the net's natural output. Failure modes: using `D` as `Z` (no inversion) → bowl; inverting
but **ignoring the shift `b`** → road still curves (the dominant residual). Correct: RANSAC-fit the road
in disparity space to recover `(a,b)`, then invert — OR use a metric model and skip all of it.
Open3D `create_point_cloud_from_depth_image`: feed real `Z` (meters), `depth_scale=1.0`, never disparity.

## Best models (unknown intrinsics, flat road, near-real-time)
1. **UniDepthV2 ViT-L** `lpiccinelli/unidepth-v2-vitl14` — metric XYZ, **predicts intrinsics**, ~15–30 fps,
   flattest ground planes. **Primary pick.**
2. **Depth Anything 3 metric** `depth-anything/DA3METRIC-LARGE` — 2026 SOTA, self-calibrates. A/B it.
3. **Metric3D-V2** `zachL1/Metric3D` — excellent *if* focal known.
4. Apple **DepthPro** `apple/DepthPro-hf` — sharp but ~3 fps.
5. **Video-Depth-Anything-Small** — for temporal stability (single shared scale across a clip).

## Fisheye
Undistort the road region to **moderate-balance rectilinear** (cv2.fisheye Kannala-Brandt) before depth
so the net sees in-distribution pinhole imagery; OR keep fisheye + **Calibration Tokens**
(github.com/JungHeeKim29/calibration-token) which adapts UniDepth/DA to fisheye with no intrinsics.

## OpenD4RT (inspected on olisgpu)
Regresses metric `xyz` directly (no back-projection, no intrinsics/pose input). Borrow: **Umeyama Sim3**
clip stitching, the reverse-pinhole intrinsics estimator (validate assumed focal), and
**depth-smoothing-before-normals**. D4RT itself is an intrinsics-free metric-3D+tracking alternative
already on the GPU box.

## Bottom line
Use a **self-calibrating metric model (UniDepthV2)** so we never guess focal, and finish **every** path
with a **one-time RANSAC ground-plane fit** — that plane fit, more than any model choice, is what makes
the flat road render flat. (Camera is static → estimate once, freeze, reuse.)
