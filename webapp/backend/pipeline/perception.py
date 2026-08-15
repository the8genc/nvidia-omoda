# Concern: own the open-vocabulary detector, loaded once on one serialized GPU | Non-concern: downstream meaning (scene) | IO: (RGB) -> detections
import os
import threading
from dataclasses import dataclass

# models are pre-cached; never phone HuggingFace at load so a flaky network cannot crash startup
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

import numpy as np
import torch

# YOLOE's mask-proto head uses ConvTranspose2d, which has no cuDNN sm_121 engine ("unable to find an
# engine"); routing convs through native CUDA kernels avoids it. We consume only boxes, not masks.
torch.backends.cudnn.enabled = False

from ultralytics import YOLOE

# open-vocabulary detector with the schema vocabulary baked in by tools/bake_yoloe.py — no text encoder
# or network needed at runtime; re-bake when the vocabulary changes
DET_MODEL_ID = "/work/models/yoloe-demo.pt"
# very low floor on purpose right now: surface ALL candidate boxes (incl. weak fire/smoke) for visual review
_DET_CONF = 0.05


def select_device() -> str:
    return "cuda" if torch.cuda.is_available() else "cpu"


@dataclass(frozen=True)
class Detection:
    label: str
    x1: float
    y1: float
    x2: float
    y2: float
    conf: float


class Perception:
    def __init__(self, device: str):
        self._device = device
        self._det = YOLOE(DET_MODEL_ID)
        self._det.to(device)
        self._gpu = threading.Lock()

    def detect(self, rgb: np.ndarray) -> list[Detection]:
        with self._gpu:
            return self._detect(rgb)

    def _detect(self, rgb: np.ndarray) -> list[Detection]:
        res = self._det.predict(rgb, conf=_DET_CONF, verbose=False, device=self._device)[0]
        if res.boxes is None:
            return []
        names = res.names
        out = []
        for b in res.boxes:
            label = names[int(b.cls[0])]
            conf = float(b.conf[0])
            x1, y1, x2, y2 = (float(v) for v in b.xyxy[0].tolist())
            out.append(Detection(label, x1, y1, x2, y2, conf))
        return out
