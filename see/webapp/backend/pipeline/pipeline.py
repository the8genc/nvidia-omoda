# Concern: backend-agnostic processing holding the once-loaded detector | Non-concern: HTTP, serving (app) | IO: (rgb) -> detections
import numpy as np

from .perception import DET_MODEL_ID, Perception, select_device


class Pipeline:
    def __init__(self):
        self.device = select_device()
        self.detector_id = DET_MODEL_ID
        self._perception = Perception(self.device)

    def detect(self, rgb: np.ndarray):
        return self._perception.detect(rgb)
