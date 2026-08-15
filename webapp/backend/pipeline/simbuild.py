# Concern: build the class-free render frame (the only primitive->geometry site) and apply the three.js display transform | Non-concern: origin class, quantization (scene) | IO: (scene) -> render
import numpy as np

# canonical world -> three.js display: flip X (image-left -> right) and Z (into-scene -> toward-viewer); Y (up) is shared. Single source of the display axis convention
_DISPLAY_SIGN = (-1.0, 1.0, -1.0)
# ground pad (world units, same scale as positions) around the emitted boxes so the plane reads as context, not a tight cut-out
_GROUND_PAD = 5.0
# fallback ground when a frame yields no primitives to bound
_GROUND_FALLBACK = {"extent": [-20.0, -40.0, 20.0, 0.0], "y": 0.0}


def _to_display(p: list[float]) -> list[float]:
    return [round(_DISPLAY_SIGN[0] * p[0], 3), round(_DISPLAY_SIGN[1] * p[1], 3), round(_DISPLAY_SIGN[2] * p[2], 3)]


class SimBuilder:
    def __init__(self, render_primitives: dict):
        self._prims = render_primitives

    @staticmethod
    def to_display_array(xyz: np.ndarray) -> np.ndarray:
        return xyz * np.asarray(_DISPLAY_SIGN, dtype=np.float32)

    def build(self, scene: dict) -> dict:
        primitives = []
        contact_ys = []
        # a zone-only privacy policy discloses no coordinate, so those entries have nothing to place metrically
        for o in scene["objects"]:
            if o["position"] is None:
                continue
            primitives.append(self._box(o["primitive"], o["position"], 1.0))
        for agg in scene["aggregates"]:
            if agg["position"] is None:
                continue
            # widen the box into a crowd blob at its zone position; no exact members, one anonymized volume
            primitives.append(self._box(agg["primitive"], agg["position"], 2.5))
        for p in primitives:
            contact_ys.append(round(p["position"][1] - p["size"][1] / 2.0, 3))
        return {"frame": scene["frame"], "ground": self._ground(primitives, contact_ys), "primitives": primitives}

    def _box(self, prim_name: str, contact_pos: list[float], footprint: float) -> dict:
        geom = self._prims[prim_name]
        length, height, width = geom["size"]
        display = _to_display(contact_pos)
        # rest the base on the ground-contact point by lifting the centre half a height
        center = [display[0], round(display[1] + height / 2.0, 3), display[2]]
        return {"shape": geom["shape"], "size": [length * footprint, height, width * footprint],
                "position": center, "rotation_y": 0.0, "color": geom["color"]}

    def _ground(self, primitives: list[dict], contact_ys: list[float]) -> dict:
        if not primitives:
            return dict(_GROUND_FALLBACK)
        xs = [p["position"][0] for p in primitives]
        zs = [p["position"][2] for p in primitives]
        # non-empty primitives guarantees a contact_y per primitive, so the median is always defined here
        y = round(float(np.median(contact_ys)), 3)
        return {"extent": [round(min(xs) - _GROUND_PAD, 3), round(min(zs) - _GROUND_PAD, 3),
                           round(max(xs) + _GROUND_PAD, 3), round(max(zs) + _GROUND_PAD, 3)], "y": y}
