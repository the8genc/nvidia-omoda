<!-- Concern: the B2 detector/tracker verdict — vehicles trackable, crowds under-detected, and the PII-stronger design it implies | Non-concern: the twin fusion (Stage D) or the render | IO: none -->

# B2 — detector + tracker verdict

**Setup:** `yolo11m-seg` + ByteTrack, `imgsz=1280`, classes person/bicycle/car/motorcycle/bus/truck.
Two real env fixes: cross-device link on weight download (chdir into `/work/models`); cuDNN
`conv_transpose2d` has no GB10 engine → `cudnn.enabled=False` (as in depth).

## What holds
**Vehicles track with strong, persistent identity.** Buses IDs 2 and 7 persist across ~all 10 frames
(bus 2 all 10; bus 7 frames 2–9); cars 5, 9, 11 are a stable core carried across essentially every
consecutive frame. Confidences are solid (bus 7 @0.91, car 5 @0.81). → **"large objects don't hop"
holds for vehicles** — they are cleanly detectable, classifiable, and trackable for CAD placement.

## What fails (the predicted limit)
**Dense crowds are overwhelmingly missed.** person counts per frame `[2,0,0,0,2,2,3,3,1,2]` (mean 1.5)
against hundreds visible; **zero** at the default 640px. The elevated CCTV distance + tiny dense
pedestrians sit below the detector's small-object threshold. Individual pedestrian detection is not
viable at this camera geometry. (Matches the pre-registered size/density limit.)

## The insight — turn the limit into a PII feature
Do **not** represent crowds as individual detections. Background-subtraction (B1's static mask) already
captures the crowd cleanly as a **mover region**. So:
- **Vehicles** → individual tracked instances → CAD proxies at their 3D positions.
- **Crowds** → anonymized **mover-region / density**, not per-person boxes.
This is **more PII-safe** (no per-person tracking or identity), sidesteps the detection limit, and is
honest about what the system can and cannot resolve.

**Decision: B2 closes.** Vehicles are trackable for placement; crowds are represented as anonymized
regions. Documented gap: no individual pedestrian detection at this distance — by design, not papered
over.
