# Concern: backend-agnostic processing holding once-loaded detector/schema, one method per stage | Non-concern: HTTP, serving (app) | IO: (backend dir) -> Pipeline
from pathlib import Path

import numpy as np

from .perception import DET_MODEL_ID, Perception, select_device
from .scene import SceneEmitter
from .schema import Schema


class Pipeline:
    def __init__(self, backend_dir: Path):
        self.device = select_device()
        self.detector_id = DET_MODEL_ID
        self._schema = Schema.load(backend_dir / "schema.json")
        self._perception = Perception(self.device)
        self._scene = SceneEmitter(self._schema)

    def detect(self, rgb: np.ndarray):
        return self._perception.detect(rgb)

    def build_scene(self, frame_index: int, detections) -> dict:
        return self._scene.build(frame_index, detections)
