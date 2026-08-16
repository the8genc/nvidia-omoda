# Concern: the privacy view as Open-d4rt depth — reconstruct the current frame against a recent one, reshape the grid-query depth to an image and colourise it | Non-concern: sourcing/broadcast (live owns), the point-cloud stream (d4rt_service owns) | IO: (bgr) -> depth-map bgr
from collections import deque

import cv2
import numpy as np

# square so the per-point depth reshapes straight into an image. 64 keeps the
# query decode cheap for a fast live framerate (the image is upsampled anyway).
GRID_SIDE = 64
# how far back the paired frame is. Depth from a pair needs a baseline; adjacent
# frames barely move, so pair with a frame a few back for parallax the model can use.
PAIR_GAP = 4
# the colour amplitude is locked once (95th percentile of |normalised depth|) and
# held — the same "lock it and stop breathing" the point cloud does with its scale.
LOCK_PERCENTILE = 95.0
# < 1 expands small distances from the mean plane, so points standing off the
# ground get pushed to the colour extremes and pop instead of washing out.
AMPLIFY_GAMMA = 0.5


def _colourise(depth_grid: np.ndarray, vmin: float, vmax: float, out_hw: tuple) -> np.ndarray:
    # matches Open-d4rt/infer_video.py:_colourise_depth — TURBO over a fixed range,
    # unmeasured cells left black. Returns RGB.
    height, width = out_hw
    mask = np.isfinite(depth_grid).astype(np.float32)
    filled = np.where(np.isfinite(depth_grid), depth_grid, 0.0).astype(np.float32)
    depth_up = cv2.resize(filled, (width, height), interpolation=cv2.INTER_LINEAR)
    mask_up = cv2.resize(mask, (width, height), interpolation=cv2.INTER_LINEAR)
    norm = np.clip((depth_up - vmin) / max(vmax - vmin, 1e-6), 0.0, 1.0)
    coloured = cv2.applyColorMap(np.rint(norm * 255.0).astype(np.uint8), cv2.COLORMAP_TURBO)
    coloured = cv2.cvtColor(coloured, cv2.COLOR_BGR2RGB)
    return np.where(mask_up[..., None] > 1e-3, coloured, 0).astype(np.uint8)


class DepthPrivacy:
    """Privacy view = Open-d4rt's depth estimate, colourised to an image.

    Same (bgr) -> bgr contract as Obfuscator, so the live loop serves it on
    rgb-stream exactly as it served the segmentation view. Pairs the current
    frame with a recent one (the model needs a baseline for stable depth) and
    holds the bf16 inference session open across frames — re-entering it per
    frame re-casts ~1B parameters every time. Runs on the warm engine the
    point-cloud stream owns, under its GPU lock.
    """

    def __init__(self, service, grid_side: int = GRID_SIDE):
        self._service = service  # D4rtService: owns the warm engine + gpu lock
        self._grid = int(grid_side)
        self._recon = None
        self._history = deque(maxlen=PAIR_GAP + 1)  # recent RGB frames, newest last
        self._range = None  # max |normalised depth|, locked off the first frame

    @property
    def ready(self) -> bool:
        # the engine warms asynchronously at startup; until it is up the caller
        # falls back to the segmentation view rather than a blank feed.
        return self._service.loaded

    def reset(self):
        # a new clip invalidates the locked scale, the fitted ground and the colour
        # range; drop the reconstructor so the next frame rebuilds them from scratch.
        self._recon = None
        self._history.clear()
        self._range = None

    def _reconstructor(self):
        if self._recon is None:
            self._recon = self._service.engine.live_reconstructor(
                grid_side=self._grid, segment=False, aspect=16 / 9
            )
            # fit the road plane on the first pair, so the cloud is rotated level
            # and we can colour by height above the road rather than raw depth.
            self._recon.request_calibration()
        return self._recon

    def obfuscate(self, bgr: np.ndarray) -> np.ndarray:
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        self._history.append(rgb)
        if len(self._history) < 2:
            raise RuntimeError("depth privacy: need a second frame for the pair")
        recon = self._reconstructor()
        # pair the current frame with the oldest one held (PAIR_GAP back once warm),
        # for the parallax the model turns into depth.
        pair = [self._history[0], self._history[-1]]
        with self._service.engine.gpu_lock:
            clouds = list(recon.reconstruct_window(pair))
        cloud = clouds[-1]
        h, w = bgr.shape[:2]
        ground = recon.ground
        if ground is not None:
            # the cloud is rotated so the road normal is CAMERA_UP = [0, -1, 0];
            # height above the road is therefore the negated y of the levelled
            # points. Road sits at 0, everything standing on it rises from there.
            height = -(cloud.xyz_quantised[:, 1].astype(np.float32))
            grid = height.reshape(self._grid, self._grid)
            finite = grid[np.isfinite(grid)]
            if self._range is None and finite.size:
                above = finite[finite > 0]
                self._range = max(float(np.percentile(above, LOCK_PERCENTILE)), 1e-6) if above.size else 1.0
            span = self._range or 1.0
            # 0 at the road, 1 at the locked height; gamma < 1 lifts low objects so
            # kerbs and people pop instead of washing into the road colour.
            unit = np.clip(grid / span, 0.0, 1.0) ** AMPLIFY_GAMMA
            coloured_rgb = _colourise(unit, 0.0, 1.0, (h, w))
        else:
            # ground not levelled yet (or the fit was refused): fall back to raw
            # depth so the feed is never blank, normalised by the locked scale.
            scale = recon.scale
            depth = cloud.depth.astype(np.float32)
            grid = ((depth - float(scale.centre[2])) / scale.radius).reshape(self._grid, self._grid)
            coloured_rgb = _colourise(grid, -1.0, 1.0, (h, w))
        return cv2.cvtColor(coloured_rgb, cv2.COLOR_RGB2BGR)
