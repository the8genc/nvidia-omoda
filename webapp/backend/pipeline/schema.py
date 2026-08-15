# Concern: load/index schema.json (the closed vocabulary): class/label/zone lookups and the class primitive | Non-concern: applying it to detections (scene) | IO: (schema path) -> Schema
import json
from pathlib import Path


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

    @classmethod
    def load(cls, path: Path) -> "Schema":
        return cls(json.loads(Path(path).read_text()))

    def class_for_label(self, label: str) -> str | None:
        return self._label_to_class.get(label)

    def class_spec(self, name: str) -> dict:
        return self._by_name[name]
