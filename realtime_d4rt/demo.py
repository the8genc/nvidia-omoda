# Concern: prove the standalone pipeline end to end on a real clip, printing ms/pair and point count | Non-concern: the webapp, HTTP, rendering | IO: (Open-d4rt repo, ckpt, video) -> stdout timings

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np

# Run as `python -m realtime_d4rt.demo` from the repo root, or directly; either
# way the package must be importable, so its parent is put on sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from realtime_d4rt.engine import Engine
from realtime_d4rt.feeder import PairFeeder
from realtime_d4rt.stabiliser import TemporalStabiliser
from realtime_d4rt.transport import DropQueue, pack_pair_frame


def _percentile(values: list[float], pct: float) -> float:
    return float(np.percentile(np.asarray(values), pct)) if values else 0.0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Standalone D4RT pair-streaming smoke test.")
    parser.add_argument("--repo", required=True, help="Path to the Open-d4rt repo.")
    parser.add_argument("--ckpt", required=True, help="Path to opend4rt.ckpt.")
    parser.add_argument("--config", default=None, help="model.yaml; defaults beside the ckpt.")
    parser.add_argument("--video", required=True, help="Path to a decodable clip (H.264).")
    parser.add_argument("--grid", type=int, default=64)
    parser.add_argument("--gap", type=int, default=8)
    parser.add_argument("--pairs", type=int, default=100)
    parser.add_argument("--ema", type=float, default=0.3)
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--fp32", action="store_true")
    args = parser.parse_args(argv)

    engine = Engine(
        repo_path=args.repo,
        ckpt_path=args.ckpt,
        config_path=args.config,
        grid_side=args.grid,
        device=args.device,
        use_bf16=not args.fp32,
    )
    engine.load()
    engine.warmup()

    stabiliser = TemporalStabiliser(ema_alpha=args.ema)
    feeder = PairFeeder(args.video, gap=args.gap)
    handoff = DropQueue(maxlen=2)

    gpu_ms: list[float] = []
    wall_ms: list[float] = []
    previous = time.perf_counter()
    with engine.session():
        for index, (frame_a, frame_b) in enumerate(feeder):
            cloud = engine.reconstruct(frame_a, frame_b)
            xyz = stabiliser.apply(cloud.xyz)
            lock = stabiliser.lock
            frame = pack_pair_frame(index, cloud.gpu_seconds * 1000.0, lock.centre, lock.radius, xyz, cloud.rgb)
            handoff.offer(frame)
            now = time.perf_counter()
            if index > 0:  # first pair pays lazy init and the scale lock
                gpu_ms.append(cloud.gpu_seconds * 1000.0)
                wall_ms.append((now - previous) * 1000.0)
            previous = now
            if index + 1 >= args.pairs:
                break

    dtype = "fp32" if args.fp32 else "bf16"
    print(
        f"\n{args.grid}x{args.grid}={engine.num_points} points, gap {args.gap}, {dtype}, "
        f"{len(wall_ms) + 1} pairs, wire frame {len(frame)} bytes"
    )
    print(f"  gpu   p50 {_percentile(gpu_ms, 50):6.1f} ms   p95 {_percentile(gpu_ms, 95):6.1f} ms")
    print(f"  wall  p50 {_percentile(wall_ms, 50):6.1f} ms   p95 {_percentile(wall_ms, 95):6.1f} ms")
    print(f"  sustained {len(wall_ms) / max(sum(wall_ms) / 1000.0, 1e-9):5.1f} pairs/s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
