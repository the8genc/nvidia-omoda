"""Model host: loads the engine once, off the event loop, and reports whether it is warm. There is no job queue — a stream drives the model directly, so all this owns is the loading. NOT concerned with HTTP or streaming. | I/O: (engine) -> a warm engine, or the reason it is not"""

import logging
import threading

from .engine import StreamingEngine

logger = logging.getLogger(__name__)

_JOIN_TIMEOUT_SECONDS = 30.0


class ModelHost:
    def __init__(self, engine: StreamingEngine) -> None:
        self._engine = engine
        self._thread = threading.Thread(target=self._load, name="d4rt-model-load", daemon=True)
        self._load_error: str | None = None
        self._ready = threading.Event()

    @property
    def engine(self) -> StreamingEngine:
        return self._engine

    @property
    def model_loaded(self) -> bool:
        return self._engine.loaded

    @property
    def load_error(self) -> str | None:
        return self._load_error

    def start(self) -> None:
        self._thread.start()

    def wait_ready(self, timeout: float | None = None) -> bool:
        return self._ready.wait(timeout)

    def stop(self) -> None:
        if self._thread.is_alive():
            self._thread.join(timeout=_JOIN_TIMEOUT_SECONDS)

    def _load(self) -> None:
        try:
            self._engine.load()
        except Exception as error:
            self._load_error = f"Model failed to load: {error}"
            logger.exception("Engine '%s' failed to load", self._engine.name)
        finally:
            self._ready.set()
