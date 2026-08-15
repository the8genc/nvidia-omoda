# Concern: turn a video source into consecutive (t-gap, t) frame pairs a live camera could hold | Non-concern: reconstruction, scale, transport | IO: (video path) -> iterator of RGB frame pairs

from __future__ import annotations

from collections import deque
from pathlib import Path
from typing import Iterator

import cv2
import numpy as np

DEFAULT_GAP = 8


def centre_crop_square(frame: np.ndarray) -> np.ndarray:
    """Take the middle square of the frame, per frame, as it arrives.

    Cropping not padding: bars would spend the model's fixed square budget on
    nothing and reconstruct as flat geometry floating in the scene. Because the
    crop is genuinely square, the aspect-ratio token is an honest 1.0.
    """
    height, width = frame.shape[:2]
    side = min(height, width)
    top = (height - side) // 2
    left = (width - side) // 2
    return frame[top : top + side, left : left + side]


class PairFeeder:
    """Streams a video as consecutive (t-gap, t) pairs, the way a camera would.

    Holds a ring buffer of the last gap+1 frames and nothing else: the clip is
    never in memory and the feeder cannot look ahead. Loops at end of file so a
    stored clip stands in for an endless source.
    """

    def __init__(self, video_path: str | Path, gap: int = DEFAULT_GAP, loop: bool = True) -> None:
        if gap < 1:
            raise ValueError(f"gap must be at least 1, got {gap}")
        self._path = Path(video_path)
        self._gap = int(gap)
        self._loop = bool(loop)
        self._buffer: deque[np.ndarray] = deque(maxlen=self._gap + 1)

    @property
    def gap(self) -> int:
        return self._gap

    def __iter__(self) -> Iterator[tuple[np.ndarray, np.ndarray]]:
        capture = cv2.VideoCapture(str(self._path))
        if not capture.isOpened():
            raise RuntimeError(
                f"Could not open {self._path.name}. OpenCV's bundled ffmpeg cannot decode "
                "every codec — AV1 in particular. Try an H.264 clip."
            )
        delivered = 0
        try:
            while True:
                ok, bgr = capture.read()
                if not ok:
                    if not self._loop:
                        return
                    if delivered == 0:
                        raise RuntimeError(
                            f"{self._path.name} yielded no decodable frames; it may be an "
                            "unsupported codec or a truncated upload."
                        )
                    capture.release()
                    capture = cv2.VideoCapture(str(self._path))
                    # Keep the ring buffer: the loop seam is just another pair,
                    # as it would be on a camera that never stops.
                    continue
                delivered += 1
                self._buffer.append(centre_crop_square(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)))
                if len(self._buffer) == self._buffer.maxlen:
                    yield self._buffer[0], self._buffer[-1]
        finally:
            capture.release()
