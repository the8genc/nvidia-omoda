# Concern: the single atomic writer for every artifact (manifest/scene/render JSON, binary cloud) | Non-concern: payload meaning (scene/simbuild), serving (app) | IO: (path, payload) -> file
import json
from pathlib import Path

import numpy as np


def write_json(path: Path, obj: dict) -> None:
    tmp = Path(f"{path}.tmp")
    tmp.write_text(json.dumps(obj))
    tmp.replace(path)


def write_cloud(path: Path, xyz: np.ndarray, cols: np.ndarray, labs: np.ndarray) -> None:
    # wire format: uint32 count + f32 xyz + u8 rgb + u8 label-rgb, all little-endian
    tmp = Path(f"{path}.tmp")
    with open(tmp, "wb") as f:
        f.write(np.uint32(xyz.shape[0]).tobytes())
        f.write(xyz.astype("<f4").tobytes())
        f.write(cols.astype(np.uint8).tobytes())
        f.write(labs.astype(np.uint8).tobytes())
    tmp.replace(path)
