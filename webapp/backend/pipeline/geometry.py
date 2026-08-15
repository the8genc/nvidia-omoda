# Concern: back-project a disparity frame to a canonical camera-origin point cloud | Non-concern: display axes (simbuild), quantization (scene) | IO: (disparity,u,v) -> points
from dataclasses import dataclass

import numpy as np

# stride of the dense back-projection grid: 1/16 of the pixels is enough to read structure without flooding the wire
STRIDE = 4
# floor added before inverting the disparity so the far plane (disparity -> 0) stays finite; single source of the depth inversion
_DEPTH_EPS = 0.05


@dataclass(frozen=True)
class Intrinsics:
    fx: float
    fy: float
    cx: float
    cy: float


def _metric_z(disparity):
    # the ONLY place disparity becomes a world Z; larger disparity (nearer) -> smaller Z
    return 1.0 / (disparity + _DEPTH_EPS)


class Geometry:
    # canonical camera-origin world frame: right-handed, +Y up, +Z into the scene (depth); +X is image-left by the right-hand rule.
    # units are the depth model's own fixed camera-relative scale (metric-ish, stable across a clip, NOT calibrated SI meters); phase 2 replaces this back-projection with a true-metric point-map behind the same points contract
    def __init__(self, intrinsics: Intrinsics):
        self._k = intrinsics

    def back_project_grid(self, disparity: np.ndarray) -> np.ndarray:
        h, w = disparity.shape
        z = _metric_z(disparity)
        us, vs = np.meshgrid(np.arange(w), np.arange(h))
        x_cam = (us - self._k.cx) * z / self._k.fx
        y_cam = (vs - self._k.cy) * z / self._k.fy
        big_x = (-x_cam[::STRIDE, ::STRIDE]).reshape(-1)
        big_y = (-y_cam[::STRIDE, ::STRIDE]).reshape(-1)
        big_z = (z[::STRIDE, ::STRIDE]).reshape(-1)
        return np.stack([big_x, big_y, big_z], axis=1).astype(np.float32)

    def back_project_point(self, u: float, v: float, disparity: np.ndarray) -> list[float]:
        h, w = disparity.shape
        # a box bottom-edge can land on the last row (v == h); clamp keeps the sample in-bounds
        u = int(min(max(u, 0), w - 1))
        v = int(min(max(v, 0), h - 1))
        z = _metric_z(float(disparity[v, u]))
        x_cam = (u - self._k.cx) * z / self._k.fx
        y_cam = (v - self._k.cy) * z / self._k.fy
        return [round(-x_cam, 3), round(-y_cam, 3), round(z, 3)]
