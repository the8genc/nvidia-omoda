"""Adapter to piece A (Open-d4rt/stream_pairs.py): holds the warm model and translates our engine port onto its module-level API. The single file to edit if piece A's signatures drift. NOT concerned with sessions, transport or HTTP."""

import importlib
import logging
import sys
import threading
from pathlib import Path
from types import ModuleType
from typing import Any

from .config import EngineConfig

logger = logging.getLogger(__name__)

_STREAM_MODULE = "stream_pairs"


class D4rtEngine:
    name = "d4rt"

    def __init__(self, config: EngineConfig) -> None:
        if config.repo_path is None or config.config_path is None or config.ckpt_path is None:
            raise ValueError(
                "engine.kind 'd4rt' requires engine.repo_path, engine.config_path and engine.ckpt_path"
            )
        self._repo_path = config.repo_path
        self._config_path = config.config_path
        self._ckpt_path = config.ckpt_path
        self._device = config.device
        self._model: object | None = None
        self._calibrator: Any = None
        # One card, one model. A live stream and a queued upload both want it, so
        # they take turns per unit of work rather than one starving the other.
        self._gpu_lock = threading.Lock()

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def load(self) -> None:
        driver = self._import_module(_STREAM_MODULE)
        logger.info(
            "Loading D4RT model (config=%s ckpt=%s device=%s)",
            self._config_path,
            self._ckpt_path,
            self._device,
        )
        model = driver.load_model(str(self._config_path), str(self._ckpt_path), device=self._device)
        # Ground calibration is on demand and keeps its weights on the CPU until
        # asked, so constructing it here costs no VRAM.
        self._calibrator = driver.GroundCalibrator(device=self._device)
        # Published last, because `loaded` reads it: a client connecting while the
        # labeller was still loading would otherwise get a half-built engine.
        self._model = model
        logger.info("D4RT model warm")

    @property
    def repo_path(self) -> Path:
        return self._repo_path

    @property
    def device(self) -> str:
        return self._device

    @property
    def gpu_lock(self) -> threading.Lock:
        return self._gpu_lock

    def live_reconstructor(
        self, grid_side: int, segment: bool = True, aspect: float = 16 / 9, surfaces: Any = None
    ) -> Any:
        """A pair-at-a-time reconstructor over the warm model (Open-d4rt/stream_pairs.py)."""
        if self._model is None:
            raise RuntimeError("D4RT model is not loaded; call load() first")
        stream = self._import_module(_STREAM_MODULE)
        return stream.LivePairReconstructor(
            self._model,
            grid_side=grid_side,
            device=self._device,
            surfaces=surfaces,
            calibrator=self._calibrator,
            aspect=aspect,
        )

    def class_names(self) -> list[str]:
        return ["", "terrain", "road", "sidewalk", "markings", "moving"]

    def clip_feeder(
        self,
        video_path: Path,
        frames: int,
        stride: int,
        aspect: float = 16 / 9,
        crop: tuple = (0.04, 0.04, 0.04, 0.04),
    ) -> Any:
        """Successive windows of `frames`, spaced by `stride`, holding one window at a time."""
        stream = self._import_module(_STREAM_MODULE)
        # Paced to the wall clock: the scene advances at the speed it was filmed
        # however slowly the model runs, and frames that pass meanwhile are lost
        # exactly as a live camera would lose them.
        return stream.ClipFeeder(
            video_path,
            frames=frames,
            stride=stride,
            loop=True,
            aspect=aspect,
            trim=crop,
            realtime=True,
        )

    def _import_module(self, module_name: str) -> ModuleType:
        # Piece A lives in a sibling repo whose location is configuration, so it
        # cannot be a static import; sys.path is extended once, then cached.
        repo = str(self._repo_path)
        if repo not in sys.path:
            sys.path.insert(0, repo)
        if not (self._repo_path / f"{module_name}.py").is_file():
            raise FileNotFoundError(f"Module not found in piece A: {self._repo_path / f'{module_name}.py'}")
        return importlib.import_module(module_name)


def build(config: EngineConfig) -> D4rtEngine:
    return D4rtEngine(config)
