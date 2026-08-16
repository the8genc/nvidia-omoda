"""App factory: wires config, the source store and the warm model host into a FastAPI app and owns their lifecycle. NOT concerned with route behaviour or process-level runtime tuning."""

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import router
from .config import AppConfig
from .engine import create_engine
from .library import VideoLibrary
from .model_host import ModelHost
from .scene_cache import SceneCache
from .services import Services

logger = logging.getLogger(__name__)


def _analyse_scenes(host: ModelHost, scenes: SceneCache, library: VideoLibrary) -> None:
    """Every clip's static scene, once, after the model is warm."""
    host.wait_ready()
    if host.load_error:
        return
    with host.engine.gpu_lock:
        scenes.analyse(library.all(), engine=host.engine)


def create_app(config: AppConfig) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        library = VideoLibrary(config.library.videos_dir, config.library.crops)
        await library.scan(config.limits.ffprobe_path, config.limits.ffprobe_timeout_seconds)
        host = ModelHost(create_engine(config.engine))
        scenes = SceneCache(
            str(config.engine.repo_path or ""), config.engine.device, config.library.cache_dir
        )
        app.state.services = Services(
            config=config, library=library, host=host, scenes=scenes
        )
        host.start()
        # Analysing every clip takes a while and needs the GPU, so it runs behind
        # the model load rather than blocking the port from opening.
        if config.engine.kind == "d4rt" and library.all():
            asyncio.get_running_loop().run_in_executor(
                None, _analyse_scenes, host, scenes, library
            )
        logger.info(
            "D4RT backend ready (engine=%s, %d clip(s) from %s)",
            config.engine.kind, len(library.all()), config.library.videos_dir,
        )
        try:
            yield
        finally:
            host.stop()

    app = FastAPI(title="D4RT live backend", version="0.2.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(config.server.cors_origins),
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(router)
    return app
