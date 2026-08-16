"""Static scene per clip, analysed once at startup from the whole video. A fixed camera's road is the same road all day, so the surfaces are computed from frames spread across the entire clip — the same view a real deployment would have after watching for a while — and never recomputed. NOT concerned with the ground plane, which is camera geometry and arrives per stream. | I/O: (clip paths) -> background plate + 2D ground masks"""

import hashlib
import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Frames spread across the whole clip. Spread is what removes traffic: samples
# taken close together show the same vehicles in the same places, and vote
# together in the median rather than cancelling.
SAMPLES_PER_CLIP = 48
# The world is reconstructed at the largest grid the reconstructor takes. It is
# built once and then never again, so its cost is paid at startup and its detail
# is kept for the whole session — the opposite trade to the live stream, which
# runs at whatever grid it can sustain per pair.
WORLD_GRID = 256
# Pairs spread over the clip, each yielding two reconstructions. Far more than a
# live stream could average, which is the point: the median across them is what
# removes the traffic and the per-pair noise from the geometry.
WORLD_PAIRS = 32
# Bumped whenever the analysis changes shape enough that a stored result is no
# longer what this code would produce. The clip's own hash cannot notice that —
# the video did not change, the thing we compute from it did.
CACHE_VERSION = 1
# Read in blocks rather than whole: the point is to notice a different video,
# and a few hundred megabytes through blake2b costs a fraction of a second.
HASH_BLOCK = 1 << 20


@dataclass(frozen=True)
class StaticWorld:
    """The street's own geometry, reconstructed once and kept."""

    xyz: Any  # [N, 3] int16, quantised against `radius` exactly as the wire is
    labels: Any  # [N] uint8, surface class per point
    spread: Any  # [N] uint16, how much the samples disagreed at that point
    radius: float
    camera: Any  # [3] float32, where the camera sits in the same frame
    grid_side: int
    samples: int


@dataclass(frozen=True)
class StaticScene:
    """The empty street, and where its surfaces are, for one camera."""

    plate: Any  # [H, W, 3] uint8 — the scene with its traffic removed
    surfaces: dict[int, Any]  # tile_world class id -> [H, W] bool
    samples: int
    span_seconds: float
    world: StaticWorld | None = None
    # The plane the world was built on. Live streams adopt it rather than fitting
    # their own, so their points land on this world's road instead of near it.
    ground: Any = None


class SceneCache:
    """Analyses every clip once, at startup, and holds the result.

    Deliberately eager and deliberately slow. The alternative — building the
    scene from a rolling window while streaming — spends its first minute
    reconstructing a world around whatever traffic happened to be parked, and
    never gets the benefit of the footage already on disk.
    """

    def __init__(self, repo_path: str, device: str = "cuda", cache_dir: Path | None = None) -> None:
        self._repo_path = repo_path
        self._device = device
        self._cache_dir = cache_dir
        self._scenes: dict[str, StaticScene] = {}

    def get(self, clip_id: str) -> StaticScene | None:
        return self._scenes.get(clip_id)

    def _cache_path(self, clip: Any) -> Path | None:
        """Where this exact clip, analysed by this exact code, is kept.

        Keyed on the video's own contents rather than its name or its timestamp:
        a clip that was re-encoded or replaced under the same filename has to be
        analysed again, and one that was merely copied about must not be.
        """
        if self._cache_dir is None:
            return None
        digest = hashlib.blake2b(digest_size=16)
        digest.update(f"v{CACHE_VERSION}:{WORLD_GRID}:{WORLD_PAIRS}:{SAMPLES_PER_CLIP}:{clip.crop}".encode())
        with open(clip.path, "rb") as handle:
            while block := handle.read(HASH_BLOCK):
                digest.update(block)
        return self._cache_dir / f"{clip.id}-{digest.hexdigest()}.npz"

    def _restore(self, path: Path, stream: Any) -> "StaticScene | None":
        import numpy as np

        if path is None or not path.is_file():
            return None
        try:
            stored = np.load(path, allow_pickle=False)
            world = None
            if "world_xyz" in stored:
                world = StaticWorld(
                    xyz=stored["world_xyz"],
                    labels=stored["world_labels"],
                    spread=stored["world_spread"],
                    radius=float(stored["world_radius"]),
                    camera=stored["world_camera"],
                    grid_side=int(stored["world_grid_side"]),
                    samples=int(stored["world_samples"]),
                )
            ground = None
            if "ground_rotation" in stored:
                ground = stream.GroundPlane(
                    rotation=stored["ground_rotation"],
                    origin=stored["ground_origin"],
                    normal=stored["ground_normal"],
                    offset=float(stored["ground_offset"]),
                    radius=float(stored["ground_radius"]),
                    tilt_degrees=float(stored["ground_tilt"]),
                    inliers=int(stored["ground_inliers"]),
                    road_points=int(stored["ground_road_points"]),
                )
            return StaticScene(
                plate=stored["plate"],
                surfaces={int(k): stored[f"surface_{k}"] for k in stored["surface_keys"]},
                samples=int(stored["samples"]),
                span_seconds=float(stored["span_seconds"]),
                world=world,
                ground=ground,
            )
        except Exception:
            # A cache that cannot be read is a cache that is not there. Rebuilding
            # is always correct and always available, so there is nothing to
            # report and nothing for the operator to do.
            logger.warning("Ignoring unreadable scene cache %s", path.name)
            return None

    def _store(self, path: Path, scene: "StaticScene") -> None:
        import numpy as np

        if path is None:
            return
        payload: dict[str, Any] = {
            "plate": scene.plate,
            "samples": scene.samples,
            "span_seconds": scene.span_seconds,
            "surface_keys": np.array(sorted(scene.surfaces), dtype=np.int64),
        }
        for key, mask in scene.surfaces.items():
            payload[f"surface_{key}"] = mask
        if scene.world is not None:
            payload.update(
                world_xyz=scene.world.xyz,
                world_labels=scene.world.labels,
                world_spread=scene.world.spread,
                world_radius=scene.world.radius,
                world_camera=scene.world.camera,
                world_grid_side=scene.world.grid_side,
                world_samples=scene.world.samples,
            )
        if scene.ground is not None:
            payload.update(
                ground_rotation=scene.ground.rotation,
                ground_origin=scene.ground.origin,
                ground_normal=scene.ground.normal,
                ground_offset=scene.ground.offset,
                ground_radius=scene.ground.radius,
                ground_tilt=scene.ground.tilt_degrees,
                ground_inliers=scene.ground.inliers,
                ground_road_points=scene.ground.road_points,
            )
        path.parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(path, **payload)

    def _build_world(self, engine: Any, clip: Any, surfaces: dict) -> tuple[Any, Any]:
        """Reconstruct the street once, from pairs spread over the whole clip.

        The geometry is settled by a per-point median across every pair, taken in
        the quantised frame the wire uses. That works because all the pairs share
        one ground plane and one radius — the first pair fits them and the rest
        are levelled by the same transform, so the samples are directly
        comparable and a car standing in one of them is outvoted by the rest.
        """
        import importlib

        import numpy as np

        static = importlib.import_module("static_plate")
        stream = importlib.import_module("stream_pairs")

        recon = engine.live_reconstructor(
            grid_side=WORLD_GRID, surfaces=stream.StaticSurfaces(surfaces)
        )
        recon.request_calibration()
        pairs = static.sample_pairs(clip.path, WORLD_PAIRS)

        stack: list[Any] = []
        last = None
        with recon.session():
            for first, second in pairs:
                prepared = [stream.prepare_frame(frame, clip.crop) for frame in (first, second)]
                for cloud in recon.reconstruct_window(prepared):
                    # Before the plane is fitted the points are in a different
                    # frame entirely, so those samples cannot go in the median.
                    if recon.ground is None:
                        continue
                    stack.append(cloud.xyz_quantised.astype(np.int16))
                    last = cloud
        if last is None or not stack:
            raise RuntimeError("no pair reconstructed with a ground plane")

        samples = np.stack(stack)
        settled = np.median(samples, axis=0)
        # How much the samples disagreed about each point, as a median absolute
        # deviation. This is the world measuring its own reliability: near the
        # horizon, on glare, and anywhere the depth is guesswork, the same pixel
        # lands in a different place every time. Anything downstream comparing a
        # live frame against this world needs that number, or it reads the
        # reconstruction's own noise as something moving.
        spread = np.median(np.abs(samples - settled), axis=0).max(axis=1)
        world = StaticWorld(
            xyz=settled.astype("<i2"),
            spread=np.clip(spread, 0, 65535).astype("<u2"),
            labels=last.labels.astype("uint8"),
            radius=float(last.radius),
            camera=last.camera.astype("float32"),
            grid_side=WORLD_GRID,
            samples=len(stack),
        )
        return world, recon.ground

    def analyse(self, clips: list, engine: Any = None, trim: Any = None) -> None:
        import sys

        if self._repo_path not in sys.path:
            sys.path.insert(0, self._repo_path)
        import importlib

        import numpy as np

        static = importlib.import_module("static_plate")
        stream = importlib.import_module("stream_pairs")
        # Loaded on the first clip that actually needs analysing. A playlist that
        # is entirely cached should not pay to move a segmentation net onto the
        # card only to never use it.
        masker = None

        for clip in clips:
            started = time.perf_counter()
            try:
                cached = self._cache_path(clip)
                restored = self._restore(cached, stream)
                if restored is not None:
                    self._scenes[clip.id] = restored
                    logger.info("Loaded %s from cache (%.1fs)", clip.id, time.perf_counter() - started)
                    continue
                if masker is None:
                    masker = static.GroundMasks(device=self._device)
                frames, span = static.sample_frames(clip.path, SAMPLES_PER_CLIP)
                # Prepared the same way the model sees them, so the masks line up
                # with the frames the reconstruction is built from.
                prepared = [stream.prepare_frame(frame, clip.crop) for frame in frames]
                plate = static.background_plate(prepared)
                labels = masker.labels_for(plate)
                markings = (labels == static.MARKING_GENERAL_ID) | static.carve_stripes(
                    plate, labels == static.MARKING_CROSSWALK_ID
                )
                surfaces = {
                    stream.TERRAIN: np.isin(labels, static.TERRAIN_IDS),
                    stream.ROAD: np.isin(labels, static.ROAD_IDS),
                    stream.SIDEWALK: np.isin(labels, static.SIDEWALK_IDS),
                    stream.MARKING: markings,
                }
                world, ground = (None, None)
                if engine is not None:
                    world, ground = self._build_world(engine, clip, surfaces)
                scene = StaticScene(
                    plate=plate,
                    surfaces=surfaces,
                    samples=len(prepared),
                    span_seconds=span,
                    world=world,
                    ground=ground,
                )
                self._scenes[clip.id] = scene
                self._store(cached, scene)
                logger.info(
                    "Analysed %s: %d frames over %.0fs, road %.0f%%, world %s (%.1fs)",
                    clip.id, len(prepared), span, surfaces[stream.ROAD].mean() * 100,
                    f"{world.grid_side}^2 from {world.samples} samples" if world else "none",
                    time.perf_counter() - started,
                )
            except Exception:
                logger.exception("Could not analyse %s; it will stream without a world", clip.id)
