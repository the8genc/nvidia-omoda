"""Video library: the fixed set of clips the demo cycles through, scanned once from a directory. There is no upload path — a clip is a file that is already there. NOT concerned with decoding, inference or HTTP. | I/O: (videos_dir) -> the playlist and its metadata"""

import asyncio
import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

VIDEO_SUFFIXES = (".mp4", ".mov", ".mkv", ".webm", ".avi")


@dataclass(frozen=True)
class Clip:
    """One playable clip. `id` is the filename stem, so URLs stay readable."""

    id: str
    name: str
    path: Path
    width: int
    height: int
    duration_seconds: float
    # Fractions cut from (left, top, right, bottom) before the model sees it.
    crop: tuple[float, float, float, float]

    def as_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "width": self.width,
            "height": self.height,
            "durationSeconds": self.duration_seconds,
            "crop": list(self.crop),
        }


async def _probe(path: Path, ffprobe_path: str, timeout_seconds: float) -> tuple[int, int, float]:
    process = await asyncio.create_subprocess_exec(
        ffprobe_path,
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "format=duration:stream=width,height",
        "-of", "json",
        str(path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        async with asyncio.timeout(timeout_seconds):
            stdout, _ = await process.communicate()
    except TimeoutError:
        process.kill()
        raise ValueError(f"ffprobe timed out inspecting {path.name}") from None
    if process.returncode != 0:
        raise ValueError(f"{path.name} is not a readable video")

    probed = json.loads(stdout)
    streams = probed.get("streams") or []
    if not streams:
        raise ValueError(f"{path.name} carries no video stream")
    duration = probed.get("format", {}).get("duration") or 0.0
    return int(streams[0].get("width", 0)), int(streams[0].get("height", 0)), float(duration)


DEFAULT_CROP = (0.04, 0.04, 0.04, 0.04)


class VideoLibrary:
    def __init__(self, videos_dir: Path, crops: dict | None = None) -> None:
        self._dir = Path(videos_dir).expanduser()
        self._crops = dict(crops or {})
        self._clips: dict[str, Clip] = {}

    async def scan(self, ffprobe_path: str, timeout_seconds: float) -> None:
        """Read the directory once at startup. Unreadable files are skipped, not fatal."""
        if not self._dir.is_dir():
            logger.warning("Video library directory does not exist: %s", self._dir)
            return
        found: dict[str, Clip] = {}
        for path in sorted(self._dir.iterdir()):
            if path.suffix.lower() not in VIDEO_SUFFIXES:
                continue
            try:
                width, height, duration = await _probe(path, ffprobe_path, timeout_seconds)
            except ValueError:
                logger.exception("Skipping unreadable clip: %s", path)
                continue
            found[path.stem] = Clip(
                id=path.stem,
                name=path.name,
                path=path,
                width=width,
                height=height,
                duration_seconds=duration,
                crop=tuple(self._crops.get(path.stem, DEFAULT_CROP)),
            )
        self._clips = found
        logger.info("Video library: %d clip(s) from %s", len(self._clips), self._dir)

    def all(self) -> list[Clip]:
        return list(self._clips.values())

    def get(self, clip_id: str) -> Clip | None:
        return self._clips.get(clip_id)

    def first(self) -> Clip | None:
        clips = self.all()
        return clips[0] if clips else None
