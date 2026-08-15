<!-- Concern: the pre-registered intent for Stage A blind-gate artifacts, written before any render exists | Non-concern: the reviewer wording (neutral-reviewer.md) or the per-run verdicts (recorded beside each result) | IO: none -->

# Stage A — pre-registered intent

**Ground truth** (established by inspecting one raw frame, `shibuya_05`): an urban pedestrian scramble
crossing viewed from an elevated oblique angle — a wide dark asphalt intersection with white zebra
crosswalks, dense crowds of people massed on the corners, several buses / cars / a taxi on the road,
tall buildings with signage framing the scene, scattered trees, an elevated train at upper right.

A blind reviewer, shown each artifact and told nothing, should independently surface the elements
below. Scoring = recall of these elements + any contradiction / hallucination. Verdict is reasoning,
not a checkbox; load-bearing gates hold on a miss, cosmetic ones log.

## A1 — segmentation mask overlay  (load-bearing)
- a large central region read as road / roadway / street
- paved edge regions read as sidewalk / pavement where crowds stand
- many people — dense crowds — as a distinct class, massed at the edges
- vehicles (buses / cars) as a distinct class on the road
- buildings framing the scene
- (log-only) vegetation / trees; crosswalk stripes
- **contradiction flags:** road and people not distinguished; crowds labeled as building or road

## A2 — depth map  (load-bearing)
- a coherent near→far ordering: foreground (lower frame) near, background (upper frame) far
- the road as a smooth receding surface; buildings as a far wall
- discernible scene geometry, NOT random noise
- **contradiction flags:** far buildings read nearer than the foreground; noise with no structure

## A3 — point-cloud 3D render, side + overlay  (load-bearing)
- a large flat ground surface (the intersection)
- clusters of small upright objects (people) on/around the ground; larger objects (vehicles) on it
- taller structures (buildings) at the far edge
- consistent with a street / intersection viewed in 3D from an angle
- **contradiction flags:** no ground plane; objects floating; unstructured blob
