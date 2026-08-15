# Concern: backend-agnostic processing holding once-loaded models/calib/schema, one method per stage | Non-concern: HTTP, job store, serving (app) | IO: (backend dir) -> Pipeline
import json
from pathlib import Path

import numpy as np

from .geometry import STRIDE, Geometry
from .perception import SEG_MODEL_ID, Perception, select_device
from .scene import SceneEmitter
from .schema import Schema
from .simbuild import SimBuilder
from .undistort import Calibration


class Pipeline:
    def __init__(self, backend_dir: Path):
        self.device = select_device()
        self.seg_model_id = SEG_MODEL_ID
        self._calib = Calibration.load(backend_dir / "calib.npz")
        self._schema = Schema.load(backend_dir / "schema.json")
        render_primitives = json.loads((backend_dir / "render_primitives.json").read_text())["primitives"]
        self._schema.validate_primitives(render_primitives)
        self._perception = Perception(self.device)
        self._geometry = Geometry(self._calib.intrinsics)
        self._scene = SceneEmitter(self._schema, self._geometry)
        self._sim = SimBuilder(render_primitives)

    def rectify(self, frame: np.ndarray) -> np.ndarray:
        return self._calib.rectify(frame)

    def perceive(self, rgb: np.ndarray):
        return self._perception.perceive(rgb)

    def build_cloud(self, disparity: np.ndarray, rgb: np.ndarray, seg_rgb: np.ndarray):
        # canonical grid from geometry, then the shared display transform so the twin viewer and point cloud share axes
        xyz = self._geometry.back_project_grid(disparity)
        cols = rgb[::STRIDE, ::STRIDE].reshape(-1, 3)
        labs = seg_rgb[::STRIDE, ::STRIDE].reshape(-1, 3)
        return self._sim.to_display_array(xyz), cols, labs

    def build_scene(self, frame_index: int, detections, seg_ids: np.ndarray, disparity: np.ndarray) -> dict:
        return self._scene.build(frame_index, detections, seg_ids, disparity)

    def build_render(self, scene: dict) -> dict:
        return self._sim.build(scene)
