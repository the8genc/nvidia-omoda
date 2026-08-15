<!-- Concern: the Stage C verdict — stability proven, render legibility + object-separation deferred | Non-concern: the render-fix or detector implementations (their own units) | IO: none -->

# Stage C — stabilized stream verdict

**Artifacts:** `twin_stream.mp4` (10 frames, 4 fps), `repr_03.png`, `repr_08.png`. Seg fix confirmed —
road dominant on all 10 frames (59.9–92.8%). Static mask 83.3% (seg-independent). Anchor: per-pixel
temporal-mean depth pins static pixels at identical Z every frame; movers use per-frame depth.

## What's proven
**Stability — the core Stage-C claim — holds.** repr_03 and repr_08 **register**: the same relief
structure sits in the same position under the fixed viewpoint, i.e. the anchored background does not
drift or flicker; only movers differ subtly. Labels are stable frame-to-frame (fixed seg road-dominant
on all 10; no hop). This is stability by construction (the anchor) *and* confirmed by the frames
registering.

## Two limitations (documented, being addressed — not band-aided)
1. **Render is washed out.** The matplotlib 3D scatter renders pale label colors on white, so the
   labels are barely visible and the scene is illegible — a *visualization* failure, not a data one
   (the seg labels + anchored depth are correct). The blind "coherent labeled scene" gate cannot run on
   this render. → a render-legibility fix (opaque colors, dark background) is needed and is spawned.
2. **Still a 2.5D relief** (the A3 finding). Even rendered well, a monocular-depth lift reads as a
   labeled *surface*, not a populated street with separated objects. → separated objects require the
   **detector (B2)**, spawned next; that is what turns the relief into a scene and enables the twin.

## Decision
**Stage-C stability: proven.** The blind scene-gate is **deferred** to the legibility-fixed render, and
the "populated scene" depends on B2. Both follow-ups launched in parallel.
