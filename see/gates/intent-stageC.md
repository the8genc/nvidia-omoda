<!-- Concern: the pre-registered intent for Stage C (the stabilized labeled point-cloud stream), written before the artifact exists | Non-concern: reviewer wording or per-run verdicts | IO: none -->

# Stage C — pre-registered intent

Stream the full pipeline over the 10-frame clip: fixed seg (labels, `do_resize=False`) + depth +
background-subtraction static mask + temporal-mean background anchor → a stabilized, label-colored
point-cloud rendered from one fixed viewpoint per frame, assembled into a short video.

**Blind gate (representative stream frames):** each frame reads as a coherent labeled 3D scene — a
ground surface with distinct labeled regions — consistent in structure from frame to frame.

**Stability (by construction + numeric):**
- the static background (ground / buildings) is rendered from the SAME anchored depth every frame → it
  does not drift or flicker; only movers change position frame-to-frame.
- large structures' labels do not hop across frames (fixed seg is road-dominant on all 10 frames).

**Contradiction flags:** the background flickers/warps between frames; the ground's label flips
frame-to-frame; unstructured noise with no stable scene.
