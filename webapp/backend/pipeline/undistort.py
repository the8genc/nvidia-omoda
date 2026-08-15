# Concern: step 0 — load frozen calibration, build the rectify map once, rectify frames, own rectified K | Non-concern: sampling (app), back-projection (geometry) | IO: (calib,BGR) -> rectified BGR + K
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from .geometry import Intrinsics


@dataclass(frozen=True)
class Calibration:
    map1: np.ndarray
    map2: np.ndarray
    intrinsics: Intrinsics
    size: tuple[int, int]

    @classmethod
    def load(cls, path: Path) -> "Calibration":
        # calibration is mandatory: a missing or corrupt file must fail loudly here, never degrade to a passthrough or invented intrinsics
        data = np.load(path)
        k = data["K"].astype(np.float64)
        dist = data["dist"].astype(np.float64)
        new_k = data["newK"].astype(np.float64)
        w = int(round(2.0 * k[0, 2]))
        h = int(round(2.0 * k[1, 2]))
        map1, map2 = cv2.initUndistortRectifyMap(k, dist, None, new_k, (w, h), cv2.CV_16SC2)
        intrinsics = Intrinsics(float(new_k[0, 0]), float(new_k[1, 1]), float(new_k[0, 2]), float(new_k[1, 2]))
        return cls(map1, map2, intrinsics, (w, h))

    def rectify(self, frame: np.ndarray) -> np.ndarray:
        # a frame whose size does not match the calibrated sensor is a real error, not a reason to hand back the raw fisheye frame
        fh, fw = frame.shape[:2]
        if (fw, fh) != self.size:
            raise ValueError(f"frame {fw}x{fh} does not match calibrated sensor {self.size[0]}x{self.size[1]}")
        return cv2.remap(frame, self.map1, self.map2, cv2.INTER_LINEAR)
