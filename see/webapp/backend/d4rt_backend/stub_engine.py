"""Stub engine: a GPU-free stand-in that streams synthetic pair clouds at a believable rate, so the service and the UI can be built and tested without the card. NOT concerned with reconstruction — nothing it emits is derived from the video."""

import logging
import math
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from typing import Any

from .config import EngineConfig
from .engine import StreamingEngine

logger = logging.getLogger(__name__)

_STUB_PAIR_SECONDS = 0.03
_STUB_RADIUS = 1.0


class _FakeArray:
    """Enough of the numpy surface for `pack_frame`; the stub venv has no numpy."""

    def __init__(self, payload: bytes, rows: int) -> None:
        self._payload = payload
        self.shape = (rows,)

    def tobytes(self) -> bytes:
        return self._payload

    def astype(self, _dtype: str) -> "_FakeArray":
        return self


@dataclass
class _StubCloud:
    xyz_quantised: _FakeArray
    depth: list[float]
    confidence: list[float]
    rgb: _FakeArray
    labels: _FakeArray
    radius: float
    camera: tuple
    point_scale: float
    gpu_seconds: float


class _StubReconstructor:
    """Emits a rotating helix so the viewer has something that visibly moves."""

    def __init__(self, grid_side: int) -> None:
        self.num_points = grid_side * grid_side
        self._phase = 0.0
        # The stub has no scene to find a ground plane in, so it stays unlevelled.
        self.ground = None
        self.ground_error = None

    def request_calibration(self) -> None:
        self.ground_error = "The stub engine has no scene to find a ground plane in."

    def clear_ground(self) -> None:
        self.ground_error = None

    def session(self):
        from contextlib import nullcontext

        return nullcontext(self)

    def reconstruct_window(self, frames: list) -> "list[_StubCloud]":
        return [self._one() for _ in frames]

    def _one(self) -> _StubCloud:
        time.sleep(_STUB_PAIR_SECONDS)
        self._phase += 0.06
        xyz = bytearray()
        rgb = bytearray()
        for index in range(self.num_points):
            t = index / max(1, self.num_points - 1)
            angle = t * math.tau * 3 + self._phase
            x = int(math.cos(angle) * 20000 * (0.3 + 0.7 * t))
            y = int((t * 2 - 1) * 24000)
            z = int(math.sin(angle) * 20000 * (0.3 + 0.7 * t))
            for value in (x, y, z):
                xyz += int(max(-32000, min(32000, value))).to_bytes(2, "little", signed=True)
            rgb += bytes((int(255 * t), 90, int(255 * (1 - t))))
        return _StubCloud(
            labels=_FakeArray(bytes(bytearray(i % 19 for i in range(self.num_points))), self.num_points),
            xyz_quantised=_FakeArray(bytes(xyz), self.num_points),
            depth=[0.0] * self.num_points,
            confidence=[1.0] * self.num_points,
            rgb=_FakeArray(bytes(rgb), self.num_points),
            radius=_STUB_RADIUS,
            camera=(0.0, 0.0, -2.0),
            point_scale=0.02,
            gpu_seconds=_STUB_PAIR_SECONDS,
        )


class _StubFeeder:
    """Endless windows of nothing in particular — the stub never looks at the frames."""

    def __init__(self, video_path: Path, frames: int) -> None:
        if not video_path.is_file():
            raise FileNotFoundError(f"Source clip not found: {video_path}")
        self._frames = frames

    def __iter__(self):
        while True:
            yield [object()] * self._frames


class StubEngine:
    name = "stub"

    def __init__(self, _config: EngineConfig) -> None:
        self._loaded = False
        self._gpu_lock = threading.Lock()

    @property
    def loaded(self) -> bool:
        return self._loaded

    @property
    def gpu_lock(self) -> threading.Lock:
        return self._gpu_lock

    def load(self) -> None:
        self._loaded = True
        logger.warning("Stub engine active — streamed geometry is synthetic, not a reconstruction")

    def live_reconstructor(
        self, grid_side: int, segment: bool = True, aspect: float = 16 / 9, surfaces: Any = None
    ) -> _StubReconstructor:
        del segment, aspect, surfaces
        return _StubReconstructor(grid_side)

    def class_names(self) -> list[str]:
        return [f"class-{i}" for i in range(19)]

    def clip_feeder(
        self, video_path: Path, frames: int, stride: int, aspect: float = 16 / 9, crop: tuple = ()
    ) -> _StubFeeder:
        del stride, aspect, crop
        return _StubFeeder(video_path, frames)


def build(config: EngineConfig) -> StreamingEngine:
    return StubEngine(config)
