# Concern: warm D4RT model + the pair reconstruct path, held-open bf16 session, prebuilt query grid | Non-concern: frame sourcing, temporal scale, transport | IO: (two RGB frames, warm model) -> raw pair cloud

from __future__ import annotations

import importlib
import sys
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

import numpy as np
import torch
import torch.nn.functional as F

# Newest frame of the pair. All queries are answered in this frame's own camera,
# which for a fixed camera is a stable world frame across pairs.
TARGET_IN_PAIR = 1
ASPECT_SQUARE = 1.0
DEFAULT_GRID_SIDE = 64


@dataclass(frozen=True)
class PairCloud:
    xyz: np.ndarray  # [N, 3] float32, position in the target frame's camera
    confidence: np.ndarray  # [N] float32
    rgb: np.ndarray  # [N, 3] uint8, sampled at the query grid
    gpu_seconds: float


class Engine:
    """Loads the checkpoint once and reconstructs a frame pair into a raw point cloud.

    The three optimisations from the brief live here: the query tensors are built
    once, inference runs under one bf16 autocast session held open across pairs,
    and the 3D grid_sample patch sampler is inside the Open-d4rt model itself.
    """

    def __init__(
        self,
        repo_path: str | Path,
        ckpt_path: str | Path,
        config_path: str | Path | None = None,
        grid_side: int = DEFAULT_GRID_SIDE,
        device: str = "cuda",
        use_bf16: bool = True,
    ) -> None:
        self._repo_path = Path(repo_path)
        self._ckpt_path = Path(ckpt_path)
        # The checkpoint ships its own model.yaml beside it; that is the honest default.
        self._config_path = Path(config_path) if config_path else self._ckpt_path.parent / "model.yaml"
        self._grid_side = int(grid_side)
        self._device = torch.device(device)
        self._use_bf16 = bool(use_bf16)
        self._model = None
        self._net = None
        self._in_session = False
        self._image_hw: tuple[int, int] = (256, 256)
        self._aspect: torch.Tensor | None = None
        self._query: dict[str, torch.Tensor] | None = None
        self._grid_px: np.ndarray | None = None
        self._run_queries = None

    @property
    def loaded(self) -> bool:
        return self._model is not None

    @property
    def num_points(self) -> int:
        return self._grid_side * self._grid_side

    @property
    def image_hw(self) -> tuple[int, int]:
        return self._image_hw

    def load(self) -> None:
        # Open-d4rt is a sibling repo whose location is configuration, so it is
        # imported dynamically once rather than as a static top-level import.
        repo = str(self._repo_path)
        if repo not in sys.path:
            sys.path.insert(0, repo)
        infer_video = importlib.import_module("infer_video")
        tasks = importlib.import_module("src.eval.tasks")
        self._run_queries = tasks._run_model_for_queries

        self._model = infer_video.load_model(
            str(self._config_path), str(self._ckpt_path), device=str(self._device)
        )
        self._net = self._model.net
        self._net.eval()
        self._image_hw = (int(self._model.image_hw[0]), int(self._model.image_hw[1]))
        self._aspect = torch.tensor([[ASPECT_SQUARE]], device=self._device, dtype=torch.float32)
        self._build_query_grid()

    def _build_query_grid(self) -> None:
        # A fixed screen-space grid, both times pinned to the newest frame. It
        # never changes across pairs, so rebuilding it per pair would cost more
        # than the model does.
        rows, cols = np.meshgrid(
            np.linspace(0.0, 1.0, self._grid_side),
            np.linspace(0.0, 1.0, self._grid_side),
            indexing="ij",
        )
        uv = np.stack([cols.reshape(-1), rows.reshape(-1)], axis=1).astype(np.float32)
        pinned = torch.full((uv.shape[0],), TARGET_IN_PAIR, dtype=torch.long, device=self._device)
        self._query = {
            "u": torch.from_numpy(uv[:, 0]).to(self._device),
            "v": torch.from_numpy(uv[:, 1]).to(self._device),
            "t_src": pinned,
            "t_tgt": pinned,
            "t_cam": pinned,
        }
        self._grid_px = np.rint(
            uv * np.array([self._image_hw[1] - 1, self._image_hw[0] - 1], dtype=np.float32)
        ).astype(np.int32)

    @contextmanager
    def session(self) -> Iterator["Engine"]:
        """Hold inference mode open for the whole stream.

        autocast caches its bf16 weight copies for the life of the context and
        drops them on exit, so entering it per pair re-casts ~1B parameters every
        time — about 6 ms a pair, more than the query decode costs.
        """
        if self._model is None:
            raise RuntimeError("Engine.load() must be called before opening a session")
        with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16, enabled=self._use_bf16):
            self._in_session = True
            try:
                yield self
            finally:
                self._in_session = False

    def warmup(self) -> None:
        # First pair measures ~8x steady state (lazy CUDA init, allocator growth).
        # Pay it here, before any client sees a frame.
        blank = np.zeros((*self._image_hw, 3), dtype=np.uint8)
        with self.session():
            self.reconstruct(blank, blank)

    def reconstruct(self, frame_a: np.ndarray, frame_b: np.ndarray) -> PairCloud:
        """The whole GPU path. Two RGB frames in — nothing else is in scope."""
        if not self._in_session:
            raise RuntimeError("reconstruct() must run inside `with engine.session():`")
        started = time.perf_counter()
        video = self._to_model_tensor(frame_a, frame_b)
        memory = self._net.encode_video(video=video, aspect_ratio=self._aspect)
        predicted = self._run_queries(
            model=self._net,
            video_b=video,
            aspect_b=self._aspect,
            query=self._query,
            chunk_size=self.num_points,
            memory_b=memory,
        )
        torch.cuda.synchronize()
        gpu_seconds = time.perf_counter() - started
        return PairCloud(
            xyz=predicted["xyz_3d"].float().numpy(),
            confidence=predicted["confidence"].float().numpy().astype(np.float32),
            rgb=self._sample_rgb(frame_b),
            gpu_seconds=gpu_seconds,
        )

    def _to_model_tensor(self, frame_a: np.ndarray, frame_b: np.ndarray) -> torch.Tensor:
        stacked = np.stack([frame_a, frame_b])
        tensor = torch.from_numpy(stacked).to(self._device, non_blocking=True)
        tensor = tensor.permute(0, 3, 1, 2).float().div_(255.0)
        if tensor.shape[-2:] != self._image_hw:
            tensor = F.interpolate(tensor, size=self._image_hw, mode="area")
        return tensor.unsqueeze(0)

    def _sample_rgb(self, frame: np.ndarray) -> np.ndarray:
        height, width = frame.shape[:2]
        scale_x = (width - 1) / max(1, self._image_hw[1] - 1)
        scale_y = (height - 1) / max(1, self._image_hw[0] - 1)
        cols = np.clip(np.rint(self._grid_px[:, 0] * scale_x), 0, width - 1).astype(np.int32)
        rows = np.clip(np.rint(self._grid_px[:, 1] * scale_y), 0, height - 1).astype(np.int32)
        return frame[rows, cols]
