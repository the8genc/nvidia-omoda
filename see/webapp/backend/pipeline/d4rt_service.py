# Concern: D4RT reconstruction subsystem — warm the 13GB engine once, build each clip's static world on demand, and hand out a fresh LiveStreamSession per socket | Non-concern: HTTP routing/wire framing (app owns), the reconstruction internals (d4rt_backend + Open-d4rt own), rgb/detection (live) | IO: (current source path) -> a warm engine, a per-clip StaticScene, and live pair sessions
#
# This is the adopted d4rt_backend package (their much-improved reconstruction
# stack) driven from our webapp. It replaces the old pipeline/d4rt_live.py: the
# richer stack builds a static world once per clip (median over 32 pairs +
# Mapillary ground masks), levels every live stream against that world's plane,
# tracks moving blobs against it, and packs the 6-class semantic wire frame.
import os
import threading
from pathlib import Path

from d4rt_backend.config import EngineConfig
from d4rt_backend.d4rt_engine import build as build_engine
from d4rt_backend.library import DEFAULT_CROP, Clip
from d4rt_backend.model_host import ModelHost
from d4rt_backend.scene_cache import SceneCache

# Container paths (deploy-dgx maps /work -> /home/acer01/hackathon). model.yaml
# must be the checkpoint's OWN config, not Open-d4rt/configs/model_effective.yaml
# — that recipe builds 48 timestep embeddings and fails to load this 32-frame
# checkpoint with a state_dict size mismatch.
D4RT_REPO = os.environ.get("D4RT_REPO", "/work/Open-d4rt")
D4RT_CKPT = os.environ.get("D4RT_CKPT", "/work/models/d4rt/opend4rt.ckpt")
D4RT_CONFIG = os.environ.get("D4RT_CONFIG", "/work/models/d4rt/model.yaml")
SCENE_CACHE_DIR = Path(os.environ.get("D4RT_SCENE_CACHE", "/work/models/d4rt/scene_cache"))
DEVICE = os.environ.get("D4RT_DEVICE", "cuda")

# Grid the live stream reconstructs at, per the user's ask (~96 for speed). The
# static world is always built at 256 (SceneCache.WORLD_GRID) regardless — its
# cost is paid once and its detail is kept for the whole session.
DEFAULT_GRID = int(os.environ.get("D4RT_GRID", "96"))

# default2/default4 are the same camera and carry a picture-in-picture inset of a
# second feed across the top-left corner plus a text banner along the top — a
# whole unrelated scene the model would otherwise fold into this one. Ported
# verbatim from their config.gpu.yaml.
CROPS: dict[str, tuple[float, float, float, float]] = {
    "default2": (0.19, 0.10, 0.04, 0.04),
    "default4": (0.19, 0.10, 0.04, 0.04),
}


class D4rtService:
    # Owns the warm engine and the per-clip static-scene cache. A live socket asks
    # for the current clip's scene (built once, then cached to npz) and drives its
    # own LiveStreamSession off the shared engine — the engine's gpu_lock keeps the
    # live stream and any world build from colliding on the one card.
    def __init__(self) -> None:
        config = EngineConfig(
            kind="d4rt",
            repo_path=Path(D4RT_REPO),
            config_path=Path(D4RT_CONFIG),
            ckpt_path=Path(D4RT_CKPT),
            device=DEVICE,
        )
        self._engine = build_engine(config)
        self._host = ModelHost(self._engine)
        self._scenes = SceneCache(repo_path=D4RT_REPO, device=DEVICE, cache_dir=SCENE_CACHE_DIR)
        # One clip's world at a time is built under this; a second viewer of the
        # same clip waits on the cache rather than kicking off a duplicate build.
        self._build_lock = threading.Lock()

    def start(self) -> None:
        # Warm the 13GB engine off the event loop (128GB unified, room to spare),
        # so the first viewer sees frames after only the per-clip world build.
        self._host.start()

    @property
    def engine(self):
        return self._engine

    @property
    def default_grid(self) -> int:
        return DEFAULT_GRID

    @property
    def loaded(self) -> bool:
        return self._host.model_loaded

    @property
    def load_error(self) -> str | None:
        return self._host.load_error

    def clip_for(self, source_path) -> Clip:
        # Our LiveLoop names the source by file; the reconstruction stack only
        # needs id/path/crop, so width/height/duration stay zero (ffprobe is the
        # library's job, and we bypass the library here).
        path = Path(source_path)
        return Clip(
            id=path.stem,
            name=path.name,
            path=path,
            width=0,
            height=0,
            duration_seconds=0.0,
            crop=CROPS.get(path.stem, DEFAULT_CROP),
        )

    def scene(self, clip_id: str):
        # The cached StaticScene, or None if it has not been built yet.
        return self._scenes.get(clip_id)

    def ensure_scene(self, clip: Clip):
        # Build (or restore from npz) this clip's static world once. Slow: 32 pairs
        # at grid 256 + a Mapillary ground pass, all on the one card. Held under the
        # engine's gpu_lock so a concurrent live pair does not interleave with it.
        existing = self._scenes.get(clip.id)
        if existing is not None:
            return existing
        with self._build_lock:
            if self._scenes.get(clip.id) is None:
                with self._engine.gpu_lock:
                    self._scenes.analyse([clip], engine=self._engine)
        return self._scenes.get(clip.id)
