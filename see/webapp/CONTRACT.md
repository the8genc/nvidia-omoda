<!-- Concern: the backend<->frontend API contract for the pipeline viewer webapp | Non-concern: backend model internals or frontend component design | IO: none -->

# Webapp API contract

Backend runs on the DGX (in the `hackathon-cv` container, models loaded once), exposed over the
tailnet with CORS open. Base path `/api`. The frontend never runs models — it fetches processed
per-frame artifacts and renders them synchronized.

## Endpoints
- `GET /api/demo` — returns `{ "job_id": "demo" }` for the persistent, pre-processed Bellevue job the
  viewer boots into. `404` when no demo exists; the frontend then falls back to the empty dropzone.
- `POST /api/process` — multipart form, field `video` (a dropped surveillance video). Returns
  `{ "job_id": "<id>" }`. The backend extracts frames (~6 fps) and runs depth + seg over all of them.
- `GET /api/jobs/{job_id}` — manifest:
  `{ "status": "processing" | "ready" | "error", "n_frames": int, "fps": number, "width": int,
     "height": int, "progress": 0..1 }`
- `GET /api/jobs/{job_id}/frames/{i}/rgb.jpg` — the raw RGB frame i.
- `GET /api/jobs/{job_id}/frames/{i}/depth.png` — depth visualization (turbo colormap), frame i.
- `GET /api/jobs/{job_id}/frames/{i}/seg.png` — segmentation overlaid on RGB (alpha ~0.5), frame i.
- `GET /api/jobs/{job_id}/frames/{i}/cloud.bin` — point-cloud payload for three.js, frame i:
  a little-endian binary: `uint32 count`, then `count` × `float32 x, float32 y, float32 z`
  (back-projected, 60° FOV), then `count` × `uint8 r,g,b` (RGB texture), then `count` × `uint8 lr,lg,lb`
  (Cityscapes label color). Points are a stride-4 grid (~57k). Frontend toggles RGB vs label color.

## Notes
- Frame index `i` is 0-based, `0 .. n_frames-1`.
- The frontend drives all views from one shared `currentFrame` clock (global play/pause).
- Seg model is swappable server-side; the winning model from the seg bake-off is dropped in without
  changing this contract.
