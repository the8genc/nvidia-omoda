# Concern: load/index schema.json (the closed vocabulary): class/label/zone lookups and the position policy | Non-concern: applying it (scene), class->geometry (simbuild) | IO: (schema path) -> Schema
import json
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class PositionPolicy:
    # the schema owns location granularity; "grid" snaps every axis to cell_meters, "zone" discloses no coordinate at all
    mode: str
    cell_meters: float | None

    def quantize(self, pos: list[float]) -> list[float] | None:
        # snap ALL of X,Y,Z to the approved cell: the back-projected Y is depth-coupled, so leaving it at full precision would leak a position finer than the cell; zone mode carries no coordinate
        if self.mode == "zone":
            return None
        c = self.cell_meters
        return [round(round(pos[0] / c) * c, 3), round(round(pos[1] / c) * c, 3), round(round(pos[2] / c) * c, 3)]


class Schema:
    def __init__(self, raw: dict):
        self.zones = raw["zones"]
        self._by_name = {}
        self._label_to_class = {}
        for c in raw["classes"]:
            if "primitive" not in c:
                raise ValueError(f"schema class {c['name']!r} declares no 'primitive'")
            if "track" not in c:
                raise ValueError(f"schema class {c['name']!r} declares no 'track'")
            self._by_name[c["name"]] = c
            for lab in c.get("detector_labels", []):
                self._label_to_class[lab] = c["name"]
        policy = raw["position_policy"]
        if policy["mode"] not in ("grid", "zone"):
            raise ValueError(f"unsupported position_policy mode {policy['mode']!r}")
        if policy["mode"] == "grid" and policy.get("cell_meters") is None:
            raise ValueError("grid position_policy requires cell_meters")
        self.position_policy = PositionPolicy(policy["mode"], policy.get("cell_meters"))

    @classmethod
    def load(cls, path: Path) -> "Schema":
        return cls(json.loads(Path(path).read_text()))

    def class_for_label(self, label: str) -> str | None:
        return self._label_to_class.get(label)

    def class_spec(self, name: str) -> dict:
        return self._by_name[name]

    def validate_primitives(self, render_primitives: dict) -> None:
        # fail fast at startup if any approved class points at a primitive the render table cannot draw
        for name, spec in self._by_name.items():
            if spec["primitive"] not in render_primitives:
                raise ValueError(f"class {name!r} primitive {spec['primitive']!r} absent from render_primitives")
