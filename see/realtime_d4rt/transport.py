# Concern: quantise a stabilised pair to the self-describing binary wire frame and hand it off fresh-not-complete | Non-concern: sockets, the model, scale locking | IO: (xyz, rgb, lock) -> bytes

from __future__ import annotations

import struct
from collections import deque

import numpy as np

# int16 packing range, matching the client dequantise x = q / 32000.
QUANT_RANGE = 32000.0
# offset  type      field
# 0       uint32    frame index
# 4       float32   gpu milliseconds
# 8       float32   scene radius
# 12      uint32    numPoints
# 16      int16[N*3]  xyz quantised to +/-32000 of the locked radius
# 16+6N   uint8 [N*3]  rgb sampled at the query grid
_HEADER = "<IffI"


def pack_pair_frame(
    index: int,
    gpu_ms: float,
    centre: np.ndarray,
    radius: float,
    xyz: np.ndarray,
    rgb: np.ndarray,
) -> bytes:
    offset = (xyz - centre) / max(radius, 1e-6)
    quantised = np.rint(np.clip(offset, -1.0, 1.0) * QUANT_RANGE).astype("<i2")
    header = struct.pack(_HEADER, int(index), float(gpu_ms), float(radius), int(xyz.shape[0]))
    return header + quantised.tobytes() + rgb.astype(np.uint8).tobytes()


class DropQueue:
    """Bounded hand-off that discards the oldest frame when full.

    Live means fresh, not complete. A growing backlog would show the viewer an
    ever-older scene while claiming to be live, so the oldest frame is dropped
    rather than the producer blocked.
    """

    def __init__(self, maxlen: int = 2) -> None:
        if maxlen < 1:
            raise ValueError(f"maxlen must be at least 1, got {maxlen}")
        self._buffer: deque[bytes] = deque(maxlen=maxlen)

    def offer(self, frame: bytes) -> None:
        self._buffer.append(frame)

    def take(self) -> bytes | None:
        return self._buffer.popleft() if self._buffer else None

    def __len__(self) -> int:
        return len(self._buffer)
