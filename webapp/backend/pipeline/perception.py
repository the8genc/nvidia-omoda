# Concern: own the depth/seg/detection models, loaded once, on one serialized GPU | Non-concern: downstream meaning (geometry/scene), rectification (undistort) | IO: (RGB) -> disparity/seg/detections
import threading
from dataclasses import dataclass

import numpy as np
import torch
import torch.nn.functional as F
from transformers import (
    AutoImageProcessor,
    AutoModelForDepthEstimation,
    Mask2FormerForUniversalSegmentation,
)
from ultralytics import YOLO

# the segmentation bake-off winner (crowds + clean structure); the other two are the depth and detector paired with it
SEG_MODEL_ID = "facebook/mask2former-swin-large-cityscapes-semantic"
DEPTH_MODEL_ID = "depth-anything/Depth-Anything-V2-Small-hf"
# detection-only weights: the scene-graph consumes boxes only, so the seg-mask variant would load unused decoder weight
DET_MODEL_ID = "yolo11m.pt"
# confidence floor tuned on the Bellevue clip: below ~0.35 the detector emits duplicate ghost boxes for the same object
_DET_CONF = 0.35

# GB10 arch lacks a cuDNN conv_transpose2d engine; Depth-Anything needs the native kernel instead
torch.backends.cudnn.enabled = False


def select_device() -> str:
    return "cuda" if torch.cuda.is_available() else "cpu"


@dataclass(frozen=True)
class Detection:
    label: str
    x1: float
    y1: float
    x2: float
    y2: float


class Perception:
    def __init__(self, device: str):
        self._device = device
        self._depth_proc = AutoImageProcessor.from_pretrained(DEPTH_MODEL_ID)
        self._depth = AutoModelForDepthEstimation.from_pretrained(DEPTH_MODEL_ID).to(device).eval()
        self._seg_proc = AutoImageProcessor.from_pretrained(SEG_MODEL_ID)
        self._seg = Mask2FormerForUniversalSegmentation.from_pretrained(SEG_MODEL_ID).to(device).eval()
        self._det = YOLO(DET_MODEL_ID)
        self._det.to(device)
        self._gpu = threading.Lock()

    def perceive(self, rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray, list[Detection]]:
        with self._gpu:
            return self._disparity(rgb), self._seg_ids(rgb), self._detect(rgb)

    def _disparity(self, rgb: np.ndarray) -> np.ndarray:
        # raw disparity-like output (larger = nearer), deliberately NOT per-frame min-max normalized: for this static camera the raw values are stable frame-to-frame (measured p5/median/p95 vary <5%), so back-projected positions stay stable, whereas dividing by each frame's own max would couple every coordinate to that frame's content
        h, w = rgb.shape[:2]
        inputs = self._depth_proc(images=rgb, return_tensors="pt").to(self._device)
        with torch.no_grad():
            pred = self._depth(**inputs).predicted_depth
        depth = F.interpolate(pred.unsqueeze(1), size=(h, w), mode="bicubic", align_corners=False)
        return np.clip(depth.squeeze().cpu().numpy().astype(np.float32), 0.0, None)

    def _seg_ids(self, rgb: np.ndarray) -> np.ndarray:
        h, w = rgb.shape[:2]
        inputs = self._seg_proc(images=rgb, return_tensors="pt").to(self._device)
        with torch.no_grad():
            outputs = self._seg(**inputs)
        seg = self._seg_proc.post_process_semantic_segmentation(outputs, target_sizes=[(h, w)])[0]
        return seg.cpu().numpy().astype(np.int32)

    def _detect(self, rgb: np.ndarray) -> list[Detection]:
        res = self._det.predict(rgb, conf=_DET_CONF, verbose=False, device=self._device)[0]
        if res.boxes is None:
            return []
        names = res.names
        out = []
        for b in res.boxes:
            label = names[int(b.cls[0])]
            x1, y1, x2, y2 = (float(v) for v in b.xyxy[0].tolist())
            out.append(Detection(label, x1, y1, x2, y2))
        return out
