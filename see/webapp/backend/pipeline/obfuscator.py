# Concern: FastSAM privacy obfuscation of a single frame — segment everything, flatten each segment to its mean colour | Non-concern: sourcing/broadcast (live owns), labels (class-agnostic) | IO: (bgr) -> obfuscated bgr
import os

import cv2
import numpy as np

FASTSAM_MODEL = os.environ.get("FASTSAM_MODEL", "FastSAM-s.pt")  # cached in the backend dir on the mount
IMGSZ = int(os.environ.get("FASTSAM_IMGSZ", "640"))
# segment/fill at this width then upsample to display res — far cheaper and the linear upsample softens edges
WORK_WIDTH = int(os.environ.get("OBFUSCATE_WIDTH", "384"))


class Obfuscator:
    # loads FastSAM lazily and turns a frame into a privacy view: every segment one colour (its mean),
    # so shapes/layout survive but faces/plates/fine detail do not. cuDNN is disabled process-wide
    # (perception.py) — FastSAM's seg head would otherwise hit the GB10 sm_121 conv_transpose gap.
    def __init__(self):
        self._model = None

    @property
    def ready(self) -> bool:
        return self._model is not None

    def load(self):
        from ultralytics import FastSAM

        print("loading FastSAM ...", flush=True)
        self._model = FastSAM(FASTSAM_MODEL)
        self._model.to("cuda")
        print("FastSAM ready", flush=True)

    def obfuscate(self, bgr: np.ndarray) -> np.ndarray:
        if self._model is None:
            self.load()
        h, w = bgr.shape[:2]
        sw = WORK_WIDTH
        sh = max(1, round(h * sw / w))
        small = cv2.resize(bgr, (sw, sh), interpolation=cv2.INTER_AREA)
        rgb = cv2.cvtColor(small, cv2.COLOR_BGR2RGB)
        res = self._model.predict(rgb, imgsz=IMGSZ, verbose=False, device="cuda")[0]
        out = np.zeros_like(small)
        if res.masks is not None:
            masks = res.masks.data.cpu().numpy() > 0.5  # [N, mh, mw]
            areas = masks.reshape(masks.shape[0], -1).sum(axis=1)
            # largest segments first so small items land on top rather than being buried
            for i in np.argsort(-areas):
                mk = cv2.resize(masks[i].astype(np.uint8), (sw, sh), interpolation=cv2.INTER_NEAREST).astype(bool)
                if not mk.any():
                    continue
                out[mk] = small[mk].mean(axis=0)
        # upsample smoothly to display resolution — softens the segment edges
        return cv2.resize(out, (w, h), interpolation=cv2.INTER_LINEAR)
