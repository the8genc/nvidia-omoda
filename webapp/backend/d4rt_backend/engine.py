"""Engine port: the streaming interface the app depends on, plus the config-driven factory. NOT concerned with sources, transport or HTTP. | I/O: (EngineConfig) -> StreamingEngine"""

import importlib
import threading
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from .config import EngineConfig


@runtime_checkable
class StreamingEngine(Protocol):
    name: str

    @property
    def loaded(self) -> bool: ...

    @property
    def gpu_lock(self) -> threading.Lock: ...

    def load(self) -> None: ...

    def live_reconstructor(self, grid_side: int, segment: bool, aspect: float) -> Any: ...

    def class_names(self) -> list[str]: ...

    def clip_feeder(self, video_path: Path, frames: int, stride: int) -> Any: ...


def create_engine(config: EngineConfig) -> StreamingEngine:
    # Dynamic import so the GPU engine's torch/model dependencies are never
    # imported in stub deployments (dev boxes, CI) that cannot satisfy them.
    module_name = {"stub": ".stub_engine", "d4rt": ".d4rt_engine"}[config.kind]
    module = importlib.import_module(module_name, package=__package__)
    return module.build(config)
