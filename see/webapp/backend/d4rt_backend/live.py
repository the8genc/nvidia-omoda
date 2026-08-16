"""Live stream session: drives piece A's pair reconstructor off a looping source and frames each result for the wire. Runs the GPU on a worker thread and hands finished pairs to the socket, dropping stale ones rather than queueing them. NOT concerned with HTTP routing, job state or model internals. | I/O: (engine, source clip, stream params) -> a stream of packed pair frames"""

import asyncio
import logging
import struct
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

logger = logging.getLogger(__name__)

# Header: frame index, GPU milliseconds, scene radius, point count, then where
# the camera sits and the angular width of one grid cell. Those four let a client
# size every point analytically — size = scale * distance from the camera — so a
# screen-uniform grid tiles at any depth without measuring its neighbours. Last
# come the producer's own clock and how many blobs follow the points: the clock
# is what lets the client dead-reckon a box forward without inheriting network
# jitter into the motion.
_HEADER = struct.Struct("<IffI4ffI")
# id, kind, flags, age, centre, velocity, heading, and the box's own extent.
_BLOB = struct.Struct("<IBBH9f")

# How often the tracker actually runs, in pairs. Moving things do not need
# re-measuring thirty times a second — a car crosses a couple of centimetres
# between pairs, which is under the noise — and the client interpolates the gap
# far more smoothly than a fresh measurement would. Every frame still carries
# the current boxes, predicted forward; only the measurement is intermittent.
TRACK_EVERY = 3

MIN_GRID_SIDE = 8
# 256 is one query per model pixel — beyond that the grid only interpolates what
# the encoder already resolved. It costs 252 ms a frame and 10 GB, so it is a
# look-at-the-detail setting rather than a live one.
MAX_GRID_SIDE = 256
# The checkpoint builds 32 timestep embeddings, so a window cannot exceed that.
MIN_FRAMES = 2
MAX_FRAMES = 32
MIN_STRIDE = 1
MAX_STRIDE = 30

# Depth of the hand-off queue. Live means fresh, not complete: if the socket
# cannot keep up we discard the oldest pending frame rather than growing a
# backlog that would show the viewer an ever-older scene.
_QUEUE_DEPTH = 2


class StreamEngine(Protocol):
    """What a live stream needs from the engine — implemented by D4rtEngine."""

    @property
    def gpu_lock(self) -> threading.Lock: ...

    def live_reconstructor(self, grid_side: int, segment: bool) -> Any: ...

    def class_names(self) -> list[str]: ...

    def clip_feeder(
        self, video_path: Path, frames: int, stride: int, aspect: float, crop: tuple
    ) -> Any: ...


@dataclass(frozen=True)
class StreamParams:
    frames: int
    stride: int
    grid_side: int
    segment: bool = True
    # 16:9 keeps the whole frame and is the shape the model reads most faithfully.
    aspect: float = 16 / 9

    @staticmethod
    def parse(
        frames: int, stride: int, grid_side: int, segment: bool = True, aspect: float = 16 / 9
    ) -> "StreamParams":
        if not 0.5 <= aspect <= 3.0:
            raise ValueError(f"aspect must be in [0.5, 3.0], got {aspect}")
        if not MIN_FRAMES <= frames <= MAX_FRAMES:
            raise ValueError(f"frames must be in [{MIN_FRAMES}, {MAX_FRAMES}], got {frames}")
        if not MIN_STRIDE <= stride <= MAX_STRIDE:
            raise ValueError(f"stride must be in [{MIN_STRIDE}, {MAX_STRIDE}], got {stride}")
        if not MIN_GRID_SIDE <= grid_side <= MAX_GRID_SIDE:
            raise ValueError(f"grid must be in [{MIN_GRID_SIDE}, {MAX_GRID_SIDE}], got {grid_side}")
        return StreamParams(
            frames=int(frames),
            stride=int(stride),
            grid_side=int(grid_side),
            segment=bool(segment),
            aspect=float(aspect),
        )


def pack_frame(index: int, cloud: Any, at_seconds: float = 0.0, blobs: Any = ()) -> bytes:
    """One self-describing binary frame: header, int16 xyz, uint8 rgb, uint8 class, blobs.

    Blobs ride inside the frame rather than going out as control messages. Two
    reasons: the drop-old queue only drops `bytes`, so a per-frame dict would
    grow a backlog the moment the socket stalls; and a box and the points it
    replaced then always describe the same instant, with no ordering to get
    right at the other end.
    """
    num_points = int(cloud.xyz_quantised.shape[0])
    camera = tuple(float(value) for value in cloud.camera)
    header = _HEADER.pack(
        index,
        cloud.gpu_seconds * 1000.0,
        float(cloud.radius),
        num_points,
        camera[0],
        camera[1],
        camera[2],
        float(cloud.point_scale),
        float(at_seconds),
        len(blobs),
    )
    return (
        header
        + cloud.xyz_quantised.tobytes()
        + cloud.rgb.astype("uint8").tobytes()
        + cloud.labels.astype("uint8").tobytes()
        + b"".join(_pack_blob(blob) for blob in blobs)
    )


def _pack_blob(blob: Any) -> bytes:
    """One tracked thing. No y and no vertical speed: a box stands on the road by
    construction, and leaving them out makes a floating box unrepresentable."""
    return _BLOB.pack(
        int(blob.id),
        int(blob.kind),
        2 if blob.coasting else 0,
        min(int(blob.age), 65535),
        float(blob.centre[0]),
        float(blob.centre[1]),
        float(blob.velocity[0]),
        float(blob.velocity[1]),
        # A heading vector, never an angle: the client negates y and z, which
        # mirrors the ground plane, and an angle would come out reflected.
        float(blob.heading[0]),
        float(blob.heading[1]),
        float(blob.length),
        float(blob.width),
        float(blob.height),
    )


def _ground_message(ground: Any, error: str | None) -> dict[str, Any]:
    """What the viewer needs to show the levelling's state, and why it failed if it did."""
    if ground is None:
        return {"type": "ground", "levelled": False, "error": error}
    return {
        "type": "ground",
        "levelled": True,
        "error": None,
        "tiltDegrees": round(ground.tilt_degrees, 1),
        "inliers": ground.inliers,
        "roadPoints": ground.road_points,
    }


class LiveStreamSession:
    """Reconstructs a looping source pair by pair for as long as the client stays."""

    def __init__(
        self,
        engine: StreamEngine,
        video_path: Path,
        params: StreamParams,
        crop: tuple = (0.04, 0.04, 0.04, 0.04),
        scene: Any = None,
    ) -> None:
        self._engine = engine
        self._video_path = video_path
        self._crop = tuple(crop)
        self._scene = scene
        self._params = params
        self._stop = threading.Event()
        self._reconstructor: Any = None
        self._tracker: Any = None

    def stop(self) -> None:
        self._stop.set()

    def _tracker_for(self, reconstructor: Any):
        """The clip's blob tracker, or nothing when there is no world to compare to.

        Not a fallback path — an absence. Without the static world there is no
        empty street to subtract, and guessing at one from the stream would put
        boxes on the scenery.
        """
        world = getattr(self._scene, "world", None) if self._scene is not None else None
        if world is None:
            return None
        import importlib
        import sys

        repo = getattr(self._engine, "repo_path", None)
        if repo is None:
            return None
        if str(repo) not in sys.path:
            sys.path.insert(0, str(repo))
        blobs = importlib.import_module("moving_blobs")
        side = int(round(reconstructor.num_points ** 0.5))
        reference = blobs.WorldReference(
            world.xyz,
            world.labels,
            world.spread,
            world.grid_side,
            side,
            blobs.metres_per_unit(world.camera),
        )
        return blobs.BlobTracker(reference, world.camera)

    def _surfaces(self):
        """The clip's static surfaces, as a per-point lookup."""
        if self._scene is None:
            return None
        import importlib
        import sys

        repo = getattr(self._engine, "repo_path", None)
        if repo is None:
            return None
        if str(repo) not in sys.path:
            sys.path.insert(0, str(repo))
        return importlib.import_module("stream_pairs").StaticSurfaces(self._scene.surfaces)

    def request_calibration(self) -> None:
        """Level the ground on the next pair. Called from the socket's read side."""
        if self._reconstructor is not None:
            self._reconstructor.request_calibration()

    def clear_ground(self) -> None:
        if self._reconstructor is not None:
            self._reconstructor.clear_ground()

    def hello(self, reconstructor: Any) -> dict[str, Any]:
        return {
            "type": "hello",
            "numPoints": reconstructor.num_points,
            "gridSide": self._params.grid_side,
            "frames": self._params.frames,
            "stride": self._params.stride,
            "aspect": round(self._params.aspect, 4),
            "segment": self._params.segment,
            "classNames": self._engine.class_names() if self._params.segment else [],
            "source": self._video_path.name,
        }

    def build_reconstructor(self) -> Any:
        self._reconstructor = self._engine.live_reconstructor(
            grid_side=self._params.grid_side,
            segment=self._params.segment,
            aspect=self._params.aspect,
            surfaces=self._surfaces(),
        )
        # Stand on the world's own plane where there is one. The static world was
        # levelled once over the whole clip, and a stream that fitted its own
        # plane from its first pair would put its points in a slightly different
        # frame — near the world's road rather than on it. Only a clip with no
        # world falls back to levelling itself, and Re-level and Unlevel stay for
        # when a fit needs another go.
        ground = getattr(self._scene, "ground", None) if self._scene is not None else None
        if ground is not None:
            self._reconstructor.adopt_ground(ground)
        else:
            self._reconstructor.request_calibration()
        self._tracker = self._tracker_for(self._reconstructor)
        return self._reconstructor

    async def frames(self, reconstructor: Any):
        """Yield packed frames until the client goes away or the producer fails."""
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[bytes | BaseException | None] = asyncio.Queue()
        producer = threading.Thread(
            target=self._produce,
            args=(reconstructor, loop, queue),
            name="d4rt-live",
            daemon=True,
        )
        producer.start()
        try:
            while True:
                item = await queue.get()
                if item is None:
                    return
                if isinstance(item, BaseException):
                    raise item
                yield item
        finally:
            # Only set the flag. Awaiting the join here would be an await on the
            # cleanup path, which fails when the client's disconnect cancels us;
            # the producer is a daemon and exits on the flag by itself.
            self._stop.set()

    def _produce(self, reconstructor: Any, loop: asyncio.AbstractEventLoop, queue: asyncio.Queue) -> None:
        pending = 0

        def deliver(payload: bytes | dict | BaseException | None) -> None:
            nonlocal pending
            # Frames are droppable because a newer one is always better. Anything
            # else — the world, the plate, a levelling result — is said once and
            # never repeated, so dropping it loses it for good.
            if isinstance(payload, bytes) and queue.qsize() >= _QUEUE_DEPTH:
                held = []
                while not queue.empty():
                    try:
                        held.append(queue.get_nowait())
                    except asyncio.QueueEmpty:
                        break
                surplus = max(0, sum(isinstance(i, bytes) for i in held) - (_QUEUE_DEPTH - 1))
                for item in held:
                    if surplus and isinstance(item, bytes):
                        surplus -= 1
                        continue  # the oldest frames go, in order
                    queue.put_nowait(item)
            queue.put_nowait(payload)
            pending += 1

        try:
            feeder = self._engine.clip_feeder(
                self._video_path,
                self._params.frames,
                self._params.stride,
                self._params.aspect,
                self._crop,
            )
            seen_ground, seen_error = None, None
            index = 0
            started = time.perf_counter()
            tracked_at = started
            blobs: list = []
            with reconstructor.session():
                for window in feeder:
                    if self._stop.is_set():
                        break
                    # One encode per window; each frame leaves as soon as it decodes,
                    # so the client is paced by real work rather than by a batch.
                    # The lock spans the window because the decodes share its
                    # encoder memory, but frames are delivered as they are decoded:
                    # collecting them first would burst a whole window at the
                    # client and then stall, which reads as stutter, not as live.
                    with self._engine.gpu_lock:
                        for cloud in reconstructor.reconstruct_window(window):
                            if self._stop.is_set():
                                break
                            ground, error = reconstructor.ground, reconstructor.ground_error
                            if ground is not seen_ground or error != seen_error:
                                seen_ground, seen_error = ground, error
                                self._schedule(loop, deliver, _ground_message(ground, error))
                            now = time.perf_counter()
                            if self._tracker is not None:
                                # Scrubbed every frame, tracked every few: what
                                # leaves must never carry a vehicle's pixels,
                                # but where its box is can afford to be stale.
                                self._tracker.scrub(cloud)
                                if index % TRACK_EVERY == 0:
                                    blobs = self._tracker.update(cloud.xyz_quantised, now - tracked_at)
                                    tracked_at = now
                                else:
                                    # Between measurements the boxes still move,
                                    # on the velocity they were last measured at.
                                    blobs = self._tracker.predicted(now - tracked_at)
                            self._schedule(loop, deliver, pack_frame(index, cloud, now - started, blobs))
                            index += 1
        except Exception as error:  # surfaced to the client, not swallowed
            logger.exception("Live stream producer failed")
            self._schedule(loop, deliver, error)
        finally:
            self._schedule(loop, deliver, None)

    @staticmethod
    def _schedule(loop: asyncio.AbstractEventLoop, deliver, payload) -> None:
        # The client can vanish between two pairs, taking the loop with it; a
        # dropped last frame is the correct outcome, not an error to report.
        try:
            loop.call_soon_threadsafe(deliver, payload)
        except RuntimeError:
            pass
