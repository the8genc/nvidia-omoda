<!-- Concern: the holistic verdict for the A3 lift+render blind gate + the 2.5D-relief finding it surfaced | Non-concern: A1/A2 verdicts or the renderer implementation (DGX scripts/render3d.py) | IO: none -->

# A3 — lift & render blind-gate verdict

**Artifacts:** `results/A3/shibuya_05_pcd_{side,top}.png` — matplotlib 3D scatter of the label-colored
point cloud (57.6k pts, stride 4). Lift assumptions (declared): pinhole, 60° horizontal FOV, principal
point centered; disparity→Z linear into a positive display range. Metrically arbitrary by construction
(monocular has no calibration) — stated, not hidden.

**Blind description — side view:** a connected, roughly diagonal band of points; the dense center reads
as "an undulating, sheet-like or **terrain-like** expanse" with a ragged upper edge; an upper-right
folding/draped lobe; faint lower vertical smudge/stalk formations; a right-center "built-up" vertical
striping; "a 3D form viewed from an oblique/side angle." **Top view:** a rounded shield/bowl mass with
a horizontal scan-line striped texture and faint vertical seams.

**Verdict (reasoning).**
- **Ground surface — present.** The reviewer independently saw a single connected sheet/terrain-like
  surface (not floating blobs, not noise). ✓
- **3D from an oblique angle — present.** ✓
- **Taller far structures (buildings) — weak.** Read only as a folding lobe / vertical striping.
- **Separated objects (people/vehicles) — absent.** Only "faint smudges/stalks," not discrete objects.
- **Reads as a street/intersection — no.** Read as "undulating terrain," not a populated street.
- **Contradiction flags:** none fatal — connected (no floating), structured (not an unstructured blob).
  The scan-line striping is a back-projection/visualization artifact of a dense per-pixel depth grid.

**Key finding (the value of this gate).** A single monocular depth map lifts to a **2.5D relief** — a
per-pixel height field — so the whole scene becomes one connected surface and objects appear as *bumps
on the relief*, never as separated standing objects. This is inherent to monocular depth, not a bug,
and it **empirically confirms the pipeline architecture**: depth supplies the ground/relief; the
**detector** must supply separated objects (people/vehicles). Same category pattern as A1 — the
pre-registered intent over-attributed *things* to a *geometry* stage.

**Adequacy for what it feeds.** A3 feeds **B1 (the depth-anchor stability test)**. A coherent
single-frame relief — connected surface, not noise — is exactly what B1 needs to test whether the
static background stays put across frames. → **adequate for B1.** Populated-scene legibility is a later
door owned by the detector + object-fusion layer.

**Weakest-rung flag.** A3 is the weakest rung so far: the relief does not yet read as a scene, and the
matplotlib scatter is a poor visualization. If a later stage needs a legible scene from the cloud,
revisit (a) the renderer (shading / Open3D) and (b) fusing detector instances onto the relief. Not
band-aided now — flagged and deferred.

**Decision: CLOSE A3 with the 2.5D-relief finding. Stage A closes. Advance to Stage B (B1 depth anchor
— the crux: does the static background stay stable across two frames?).**
