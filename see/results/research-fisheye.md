<!-- Concern: actionable findings for undistorting the static fisheye traffic cam once, then remapping per frame | Non-concern: the depth-model research (its own note) | IO: none -->

# Fisheye undistort research — estimate once, remap forever

The camera never moves → **estimate distortion once (offline), bake a warp map once, then every frame is
one cheap GPU remap** (sub-ms). Two decisions: the remap engine, and how to get params with no
checkerboard.

## Remap engine (per-frame cost is negligible in all)
- **NVIDIA VPI — LDC + Remap** (recommended on NVIDIA HW): builtin fisheye (Kannala-Brandt k1–k4) and
  polynomial (Brown-Conrady) models; `generate WarpMap once` → `vpiSubmitRemap` per frame on CUDA/VIC/PVA.
  Also ingests an arbitrary dense warp map (escape hatch).
- **DeepStream `nvdewarper`** — only if already in a DeepStream pipeline (Fisheye→Perspective type 4).
- **OpenCV** (our fallback, already in-container): `cv2.fisheye.initUndistortRectifyMap` once →
  `cv2.remap` / `cv2.cuda.remap` per frame. The calibration/validation workhorse; maps interoperate with
  VPI.

## Param estimation, no checkerboard
- **AnyCalib** (ICCV 2025, **Apache-2.0**) — top pick: single image → focal, principal point, distortion
  for Brown-Conrady / Kannala-Brandt / UCM / EUCM / division (exactly the coeffs VPI/OpenCV want). Weights
  on HF/torch hub. github.com/javrtg/AnyCalib.
- **GeoCalib** (ECCV 2024) — single-image intrinsics + distortion with per-estimate uncertainty (sanity
  check). HF Space `veichta/GeoCalib`.
- **Classical plumb-line / division model** — straighten known-straight lane lines/curbs (a traffic scene
  is ideal); cross-check the deep estimate.
- **NVIDIA AutoMagicCalib** (DeepStream) — calibrates from naturally moving traffic, no downtime, but a
  simple (k1-dominant) distortion model.

## Recipe for our static fisheye pole cam
1. One clean frame → **AnyCalib/GeoCalib** for K + distortion, cross-checked by lane-line straightness.
2. Build the undistort remap once (VPI or OpenCV). Freeze it (camera is fixed).
3. Per frame: one `remap`. 4. Feed undistorted frames to depth, back-project with the **new rectified K**.

**Caveats:** match the model (true fisheye needs KB/EUCM, not k1-only) or edge curvature corrupts the 3D
lift where it matters; tune the undistort FOV/scale to keep the road without wasting resolution; validate
by straightness before freezing.
