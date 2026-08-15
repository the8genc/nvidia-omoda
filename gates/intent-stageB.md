<!-- Concern: the pre-registered intent for Stage B (two-frame continuity), written before any B artifact exists | Non-concern: the reviewer wording (neutral-reviewer.md) or per-run verdicts | IO: none -->

# Stage B — pre-registered intent

Two frames of the same static camera several seconds apart (`shibuya_05` and `shibuya_08`). The camera
does not move; the background (road, buildings, sidewalks) is physically identical; only vehicles,
pedestrians, and lighting differ.

## B1 — depth anchor (the crux)  (load-bearing)

Claim: raw monocular depth is re-estimated per frame with a floating scale/shift, so the static
background "hops" between frames; anchoring each frame's depth (affine) on the shared **static** pixels,
low-passed over time, pins the background while moving objects still translate.

**Quantitative gate (data, judged holistically):** anchored static-background frame-to-frame depth
drift is materially smaller than the raw (un-anchored) baseline drift; the residual is dominated by the
actual movers, not the static scene.

**Blind gate (on the anchored renders):** a reviewer shown the two anchored background renders
describes them as the SAME structure/layout; shown their difference, the change is localized to where
vehicles/people moved, not spread across the whole background.
- **contradiction flags:** the whole background shifts/warps between frames; the difference is global,
  not localized to movers.

## B2 — detect & track  (load-bearing)

- Large objects (buses/cars) keep a consistent identity across the two frames; a reviewer identifies
  "the same vehicle" in both; labels do not hop for large objects.
- Dense pedestrian crowds may switch identity — documented as a size/density limit, not a failure.
