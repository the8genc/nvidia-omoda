"""Service container: the wired-up singletons a request handler needs, held on app.state. NOT concerned with wiring order (see app.py) or behaviour."""

from dataclasses import dataclass

from .config import AppConfig
from .library import VideoLibrary
from .model_host import ModelHost
from .scene_cache import SceneCache


@dataclass(frozen=True)
class Services:
    config: AppConfig
    library: VideoLibrary
    scenes: SceneCache
    host: ModelHost
