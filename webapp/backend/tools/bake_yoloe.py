# Concern: bake the schema's vocabulary into a YOLOE checkpoint (text embeddings precomputed) so the runtime needs no text encoder or network | Non-concern: serving/inference (perception owns) | IO: (schema.json, base yoloe weights) -> /work/models/yoloe-demo.pt
#
# Run once (and whenever schema.json's vocabulary changes), from /work/webapp/backend where the base
# yoloe weights + mobileclip text encoder are cached:
#   docker exec -w /work/webapp/backend pipeline-backend python3 tools/bake_yoloe.py
import json
from pathlib import Path

import torch

torch.backends.cudnn.enabled = False  # YOLOE mask-proto conv_transpose has no sm_121 cudnn engine
from ultralytics import YOLOE

BASE = "yoloe-11s-seg.pt"  # base open-vocab weights (+ mobileclip), cached in this dir
SCHEMA = Path("schema.json")
OUT = Path("/work/models/yoloe-demo.pt")


def vocabulary(schema_path: Path) -> list[str]:
    raw = json.loads(schema_path.read_text())
    labels: list[str] = []
    for c in raw["classes"]:
        for lab in c.get("detector_labels", []):
            if lab not in labels:
                labels.append(lab)
    return labels


def main() -> None:
    names = vocabulary(SCHEMA)
    model = YOLOE(BASE)
    model.set_classes(names, model.get_text_pe(names))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    model.save(str(OUT))
    print(f"baked {len(names)} classes -> {OUT}")
    print("vocabulary:", names)


if __name__ == "__main__":
    main()
