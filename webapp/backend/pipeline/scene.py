# Concern: emit the per-frame closed-vocabulary scene-graph — canonical frame, quantized positions, per-zone aggregation | Non-concern: display/geometry (simbuild) | IO: (detections,seg) -> scene
import numpy as np

from .geometry import Geometry
from .schema import Schema

# Cityscapes trainId -> schema zone for the only two ground zones the segmenter resolves; everything else is left unresolved, never guessed as roadway
_SEG_ID_TO_ZONE = {0: "roadway", 1: "sidewalk"}
# crowd density within ONE zone above which a class collapses to a count; a class spread thinly across many zones stays individual. 8 ~= the point where individual boxes in a single 3 m cell overlap into an unreadable mass on the twin, so a count communicates more than the pile
_DENSE_THRESHOLD = 8


class SceneEmitter:
    def __init__(self, schema: Schema, geometry: Geometry):
        self._schema = schema
        self._geo = geometry
        # keep only the seg->zone mappings the approved vocabulary actually declares; validated once, not re-checked per pixel
        self._seg_zone = {sid: z for sid, z in _SEG_ID_TO_ZONE.items() if z in schema.zones}

    def build(self, frame_index: int, detections: list, seg_ids: np.ndarray, disparity: np.ndarray) -> dict:
        raw = []
        for det in detections:
            cls = self._schema.class_for_label(det.label)
            if cls is None:
                continue
            spec = self._schema.class_spec(cls)
            u = 0.5 * (det.x1 + det.x2)
            v = det.y2
            position = self._schema.position_policy.quantize(self._geo.back_project_point(u, v, disparity))
            raw.append({
                "class": cls,
                "primitive": spec["primitive"],
                "position": position,
                "zone": self._zone_at(u, v, seg_ids),
            })
        objects, aggregates = self._aggregate(raw)
        return {"frame": frame_index, "objects": objects, "aggregates": aggregates}

    def _zone_at(self, u: float, v: float, seg_ids: np.ndarray) -> str | None:
        h, w = seg_ids.shape
        uu = int(min(max(u, 0), w - 1))
        vv = int(min(max(v, 0), h - 1))
        return self._seg_zone.get(int(seg_ids[vv, uu]))

    def _aggregate(self, raw: list[dict]) -> tuple[list[dict], list[dict]]:
        objects = []
        aggregates = []
        by_class = {}
        for o in raw:
            by_class.setdefault(o["class"], []).append(o)
        for cls, items in by_class.items():
            spec = self._schema.class_spec(cls)
            if not spec.get("aggregate_when_dense"):
                objects.extend(items)
                continue
            by_zone = {}
            for o in items:
                by_zone.setdefault(o["zone"], []).append(o)
            for zone, zitems in by_zone.items():
                if len(zitems) > _DENSE_THRESHOLD:
                    aggregates.append({
                        "class": cls,
                        "zone": zone,
                        "count": len(zitems),
                        "primitive": spec["primitive"],
                        "position": self._crowd_position(zitems),
                    })
                else:
                    objects.extend(zitems)
        return objects, aggregates

    def _crowd_position(self, items: list[dict]) -> list[float] | None:
        # place a crowd at its own members' centre (its approved zone), re-quantized; zone-only policy discloses no coordinate
        coords = [o["position"] for o in items if o["position"] is not None]
        if not coords:
            return None
        pts = np.array(coords, dtype=np.float64)
        centroid = [float(pts[:, 0].mean()), float(pts[:, 1].mean()), float(pts[:, 2].mean())]
        return self._schema.position_policy.quantize(centroid)
