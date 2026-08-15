# Concern: FastAPI routes, job/manifest lifecycle, artifact serving, and startup bootstrap of the demo job | Non-concern: CV processing, atomic writes (pipeline pkg) | IO: (mp4 or demo) -> job_id
import json
import threading
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import cv2
import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from starlette.concurrency import run_in_threadpool

from pipeline import Pipeline, store

BACKEND_DIR = Path(__file__).resolve().parent
JOBS_ROOT = Path("/work/webapp/backend/jobs")
JOBS_ROOT.mkdir(parents=True, exist_ok=True)

# a stable, persistent demo job so the viewer opens showing Bellevue already processed; the dir survives container restarts (host bind mount)
DEMO_JOB_ID = "demo"
DEMO_VIDEO = Path("/work/bellevue_15s.mp4")

# frame sampling target; the source is decimated to roughly this many frames per second
TARGET_FPS = 6.0

# standard Cityscapes 19-class trainId palette (RGB); index == Mask2Former cityscapes class id, used only to colourize the seg and cloud-label visualizations
CITYSCAPES_PALETTE_RGB = np.array([
    (128, 64, 128), (244, 35, 232), (70, 70, 70), (102, 102, 156), (190, 153, 153),
    (153, 153, 153), (250, 170, 30), (220, 220, 0), (107, 142, 35), (152, 251, 152),
    (70, 130, 180), (220, 20, 60), (255, 0, 0), (0, 0, 142), (0, 0, 70),
    (0, 60, 100), (0, 80, 100), (0, 0, 230), (119, 11, 32),
], dtype=np.uint8)

print("building pipeline...", flush=True)
PIPELINE = Pipeline(BACKEND_DIR)
print(f"pipeline ready on {PIPELINE.device}", flush=True)


def _job_dir(job_id: str) -> Path:
    return JOBS_ROOT / job_id


def _queued_manifest() -> dict:
    return {"status": "queued", "n_frames": 0, "fps": TARGET_FPS, "width": 0, "height": 0, "progress": 0.0}


def _sample_frames(video_path: Path):
    # decode with cv2 (no ffmpeg) and sample ~TARGET_FPS; returns (list of BGR frames, w, h)
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"cv2 could not open video: {video_path}")
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    step = max(1, int(round(src_fps / TARGET_FPS)))
    frames = []
    idx = 0
    while True:
        ok, bgr = cap.read()
        if not ok:
            break
        if idx % step == 0:
            frames.append(bgr)
        idx += 1
    cap.release()
    if not frames:
        raise RuntimeError("no frames decoded from video")
    h, w = frames[0].shape[:2]
    return frames, w, h


def _process_job(job_id: str, video_path: Path) -> None:
    d = _job_dir(job_id)
    manifest_path = d / "manifest.json"
    manifest = {"status": "processing", "n_frames": 0, "fps": TARGET_FPS, "width": 0, "height": 0, "progress": 0.0}
    try:
        frames, w, h = _sample_frames(video_path)
        n = len(frames)
        manifest.update({"n_frames": n, "width": w, "height": h})
        store.write_json(manifest_path, manifest)

        # one disparity scale for the whole clip, set from the first frame, so a static point maps to the same world position in every frame
        disp_ref = None
        for i, raw_bgr in enumerate(frames):
            # step 0: rectify FIRST so every downstream artifact derives from the SAME undistorted frame
            bgr = PIPELINE.rectify(raw_bgr)
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            fdir = d / "frames" / str(i)
            fdir.mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(fdir / "rgb.jpg"), bgr, [cv2.IMWRITE_JPEG_QUALITY, 92])

            disparity, seg_ids, detections = PIPELINE.perceive(rgb)
            if disp_ref is None:
                disp_ref = max(float(np.percentile(disparity, 99)), 1e-6)
            disp = np.clip(disparity / disp_ref, 0.0, 1.0)

            cv2.imwrite(str(fdir / "depth.png"), cv2.applyColorMap((disp * 255.0).astype(np.uint8), cv2.COLORMAP_TURBO))

            seg_rgb = CITYSCAPES_PALETTE_RGB[np.clip(seg_ids, 0, len(CITYSCAPES_PALETTE_RGB) - 1)]
            overlay = cv2.addWeighted(bgr, 0.5, cv2.cvtColor(seg_rgb, cv2.COLOR_RGB2BGR), 0.5, 0.0)
            cv2.imwrite(str(fdir / "seg.png"), overlay)

            xyz, cols, labs = PIPELINE.build_cloud(disp, rgb, seg_rgb)
            store.write_cloud(fdir / "cloud.bin", xyz, cols, labs)

            scene = PIPELINE.build_scene(i, detections, seg_ids, disp)
            store.write_json(fdir / "scene.json", scene)
            store.write_json(fdir / "render.json", PIPELINE.build_render(scene))

            manifest["progress"] = float(i + 1) / float(n)
            store.write_json(manifest_path, manifest)

        manifest["status"] = "done"
        manifest["progress"] = 1.0
        store.write_json(manifest_path, manifest)
    except Exception as e:
        manifest["status"] = "error"
        manifest["error"] = f"{type(e).__name__}: {e}"
        store.write_json(manifest_path, manifest)
        print("JOB ERROR", job_id, manifest["error"], flush=True)


def _ensure_demo() -> None:
    d = _job_dir(DEMO_JOB_ID)
    manifest_path = d / "manifest.json"
    if manifest_path.exists():
        try:
            status = json.loads(manifest_path.read_text()).get("status")
        except (OSError, json.JSONDecodeError):
            status = None
        if status == "done":
            print("demo job already processed; skipping", flush=True)
            return
        # a non-done manifest left by a killed run has no live worker after restart; drop it so it is never advertised as a stuck job
        manifest_path.unlink(missing_ok=True)
    if not DEMO_VIDEO.exists():
        print(f"demo video missing at {DEMO_VIDEO}; /api/demo will 404", flush=True)
        return
    d.mkdir(parents=True, exist_ok=True)
    store.write_json(manifest_path, _queued_manifest())
    print("processing demo job in background...", flush=True)
    threading.Thread(target=_process_job, args=(DEMO_JOB_ID, DEMO_VIDEO), daemon=True).start()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # bootstrap the demo on startup, not at import, so importing this module never launches a GPU run
    threading.Thread(target=_ensure_demo, daemon=True).start()
    yield


app = FastAPI(lifespan=lifespan)
# allow the browser frontend (different origin/port) to call this API cross-origin
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/api/demo")
def get_demo():
    # 404 when the demo has no manifest so the frontend falls back to the empty dropzone
    if not (_job_dir(DEMO_JOB_ID) / "manifest.json").exists():
        raise HTTPException(status_code=404, detail="no demo job")
    return {"job_id": DEMO_JOB_ID}


@app.post("/api/process")
async def process(video: UploadFile = File(...)):
    # accept multipart 'video', persist it, kick off background processing, return job_id
    job_id = uuid.uuid4().hex[:12]
    d = _job_dir(job_id)
    d.mkdir(parents=True, exist_ok=True)
    video_path = d / "input.mp4"
    data = await video.read()
    # keep the disk write (a whole mp4) off the event loop so concurrent jobs' manifest polls are not blocked
    await run_in_threadpool(video_path.write_bytes, data)
    await run_in_threadpool(store.write_json, d / "manifest.json", _queued_manifest())
    threading.Thread(target=_process_job, args=(job_id, video_path), daemon=True).start()
    return JSONResponse({"job_id": job_id})


def _read_json_or_404(path: Path, missing: str):
    if not path.exists():
        raise HTTPException(status_code=404, detail=missing)
    return JSONResponse(json.loads(path.read_text()))


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    # sync def so FastAPI runs the blocking read in its threadpool; the frontend polls this during processing
    return _read_json_or_404(_job_dir(job_id) / "manifest.json", "job not found")


@app.get("/api/jobs/{job_id}/frames/{index}/scene.json")
def get_frame_scene(job_id: str, index: int):
    return _read_json_or_404(_job_dir(job_id) / "frames" / str(index) / "scene.json", "scene not found")


@app.get("/api/jobs/{job_id}/frames/{index}/render.json")
def get_frame_render(job_id: str, index: int):
    # registered before {asset} so it matches; sync def keeps the blocking read off the event loop the twin polls
    return _read_json_or_404(_job_dir(job_id) / "frames" / str(index) / "render.json", "render not found")


@app.get("/api/jobs/{job_id}/frames/{index}/{asset}")
def get_frame_asset(job_id: str, index: int, asset: str):
    # serve rgb.jpg / depth.png / seg.png / cloud.bin for a frame
    media = {"rgb.jpg": "image/jpeg", "depth.png": "image/png", "seg.png": "image/png", "cloud.bin": "application/octet-stream"}
    if asset not in media:
        raise HTTPException(status_code=400, detail="unknown asset")
    path = _job_dir(job_id) / "frames" / str(index) / asset
    if not path.exists():
        raise HTTPException(status_code=404, detail="asset not found")
    return FileResponse(str(path), media_type=media[asset])


@app.get("/api/health")
def health():
    return {"ok": True, "device": PIPELINE.device, "seg_model": PIPELINE.seg_model_id}
