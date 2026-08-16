# Concern: hold absolute scale steady across independently-reconstructed pairs so the cloud stops breathing | Non-concern: the model, sourcing, transport | IO: (raw xyz per pair) -> stabilised xyz

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

SCALE_PERCENTILE = 95.0
DEFAULT_EMA_ALPHA = 0.3


@dataclass(frozen=True)
class ScaleLock:
    """Centre, radius and median depth fixed from the first pair.

    depth is the one that matters: each pair is reconstructed independently and
    the model's absolute depth drifts between them (~9.1% per-point deviation on
    a static camera). Rescaling every pair onto this reference median takes that
    to ~3.6%; centre and radius alone do nothing, they only normalise packing.
    """

    centre: np.ndarray
    radius: float
    depth: float


class TemporalStabiliser:
    """Locks a reference scale on the first pair, then puts every later pair on it.

    The rescale is the big win; the EMA is a garnish. alpha=0 means show the raw
    per-pair output; 0.3 keeps ~80% of a genuinely moving point's motion.
    """

    def __init__(self, ema_alpha: float = DEFAULT_EMA_ALPHA, scale_percentile: float = SCALE_PERCENTILE) -> None:
        self._ema_alpha = float(ema_alpha)
        self._percentile = float(scale_percentile)
        self._lock: ScaleLock | None = None
        self._previous: np.ndarray | None = None

    @property
    def lock(self) -> ScaleLock | None:
        return self._lock

    def reset(self) -> None:
        self._lock = None
        self._previous = None

    def apply(self, xyz: np.ndarray) -> np.ndarray:
        if self._lock is None:
            self._lock = self._lock_scale(xyz)
            return xyz
        return self._stabilise(xyz)

    def _lock_scale(self, xyz: np.ndarray) -> ScaleLock:
        finite = xyz[np.isfinite(xyz).all(axis=-1)]
        if finite.size == 0:
            raise RuntimeError("First pair produced no finite point; cannot fix a scale.")
        centre = finite.mean(axis=0)
        radius = float(np.percentile(np.linalg.norm(finite - centre, axis=-1), self._percentile))
        self._previous = xyz if self._ema_alpha > 0.0 else None
        return ScaleLock(centre=centre, radius=max(radius, 1e-6), depth=max(self._median_depth(xyz), 1e-6))

    def _stabilise(self, xyz: np.ndarray) -> np.ndarray:
        assert self._lock is not None
        current = self._median_depth(xyz)
        if current > 1e-6:
            xyz = xyz * (self._lock.depth / current)
        if self._ema_alpha <= 0.0:
            return xyz
        if self._previous is None:
            self._previous = xyz
            return xyz
        blended = self._ema_alpha * xyz + (1.0 - self._ema_alpha) * self._previous
        blended = np.where(np.isfinite(xyz), blended, xyz)
        self._previous = blended
        return blended

    @staticmethod
    def _median_depth(xyz: np.ndarray) -> float:
        depth = np.abs(xyz[:, 2])
        finite = depth[np.isfinite(depth)]
        return float(np.median(finite)) if finite.size else 0.0
