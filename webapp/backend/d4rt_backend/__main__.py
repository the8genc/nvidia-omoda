"""Entrypoint: reads the YAML config, applies process-level resource limits, and serves the app with uvicorn. NOT concerned with routes or inference."""

import argparse
import logging
import os
import sys
from pathlib import Path

import uvicorn

from .app import create_app
from .config import RuntimeConfig, load_config

_DEFAULT_CONFIG = Path(__file__).resolve().parent.parent / "config.yaml"


def _apply_runtime_limits(runtime: RuntimeConfig) -> None:
    # Shared workstation: stay off the interactive user's toes and keep BLAS
    # from grabbing every core. Must precede any torch/numpy import.
    for variable in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS"):
        os.environ[variable] = str(runtime.omp_num_threads)
    if runtime.nice > 0:
        os.nice(runtime.nice)


def main() -> int:
    parser = argparse.ArgumentParser(prog="d4rt-backend")
    parser.add_argument("--config", type=Path, default=_DEFAULT_CONFIG)
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--log-level", default="info")
    args = parser.parse_args()

    logging.basicConfig(
        level=args.log_level.upper(),
        format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
    )
    config = load_config(args.config)
    _apply_runtime_limits(config.runtime)

    uvicorn.run(
        create_app(config),
        host=args.host or config.server.host,
        port=args.port or config.server.port,
        log_level=args.log_level,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
