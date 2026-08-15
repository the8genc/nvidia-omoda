# Concern: samples frames, runs depth/seg per frame, writes rgb/depth/seg/cloud.bin + manifest | Non-concern: displaying or decoding them (frontend owns that) | IO: (POST mp4) -> job_id + artifacts
import os
import io
import json
import time
import uuid
import threading

import numpy as np
import cv2
import torch
import torch.nn.functional as F
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import JSONResponse, Response, FileResponse
from fastapi.middleware.cors import CORSMiddleware
from transformers import (
    AutoModelForDepthEstimation,
    AutoImageProcessor,
    Mask2FormerForUniversalSegmentation,
)

# swappable segmentation model constant: the bake-off winner (crowds + clean structure)
SEG_MODEL_ID = "facebook/mask2former-swin-large-cityscapes-semantic"
DEPTH_MODEL_ID = "depth-anything/Depth-Anything-V2-Small-hf"

# on-disk job store; each job is a directory holding manifest.json + per-frame artifacts
JOBS_ROOT = "/work/webapp/backend/jobs"
os.makedirs(JOBS_ROOT, exist_ok=True)

# frame sampling target and point-cloud back-projection parameters
TARGET_FPS = 6.0
STRIDE = 4
DEPTH_EPS = 0.05

# frozen fisheye calibration owned by the backend; the camera is static so maps precompute once
CALIB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "calib.npz")

# standard Cityscapes 19-class trainId palette (RGB); index == Mask2Former cityscapes class id
CITYSCAPES_PALETTE_RGB = np.array([
    (128, 64, 128), (244, 35, 232), (70, 70, 70), (102, 102, 156), (190, 153, 153),
    (153, 153, 153), (250, 170, 30), (220, 220, 0), (107, 142, 35), (152, 251, 152),
    (70, 130, 180), (220, 20, 60), (255, 0, 0), (0, 0, 142), (0, 0, 70),
    (0, 60, 100), (0, 80, 100), (0, 0, 230), (119, 11, 32),
], dtype=np.uint8)

# cuDNN lacks a conv_transpose2d engine on this GB10 arch; native kernel is required for Depth-Anything
torch.backends.cudnn.enabled = False
device = "cuda" if torch.cuda.is_available() else "cpu"

# load BOTH models ONCE at import/startup, before any request
print("loading depth model...", flush=True)
depth_processor = AutoImageProcessor.from_pretrained(DEPTH_MODEL_ID)
depth_model = AutoModelForDepthEstimation.from_pretrained(DEPTH_MODEL_ID).to(device).eval()
print("loading segmentation model...", flush=True)
seg_processor = AutoImageProcessor.from_pretrained(SEG_MODEL_ID)
seg_model = Mask2FormerForUniversalSegmentation.from_pretrained(SEG_MODEL_ID).to(device).eval()
print("models loaded", flush=True)

# PIPELINE STEP 0: load Brown-Conrady calibration and precompute undistort maps ONCE
# on any failure/missing file we fall back to identity so non-calibrated videos still process
UNDIST_MAP1 = None
UNDIST_MAP2 = None
UNDIST_NEWK = None
try:
    _calib = np.load(CALIB_PATH)
    UNDIST_K = _calib["K"].astype(np.float64)
    UNDIST_DIST = _calib["dist"].astype(np.float64)
    UNDIST_NEWK = _calib["newK"].astype(np.float64)
    # calibration is defined for a fixed sensor size implied by the principal point
    _uw = int(round(2.0 * UNDIST_K[0, 2]))
    _uh = int(round(2.0 * UNDIST_K[1, 2]))
    UNDIST_MAP1, UNDIST_MAP2 = cv2.initUndistortRectifyMap(
        UNDIST_K, UNDIST_DIST, None, UNDIST_NEWK, (_uw, _uh), cv2.CV_16SC2)
    print(f"undistort maps ready for {_uw}x{_uh}, newK fx={UNDIST_NEWK[0,0]}", flush=True)
except Exception as e:
    print(f"undistort disabled (identity): {type(e).__name__}: {e}", flush=True)


def undistort(frame):
    # PIPELINE STEP 0: rectify a BGR frame; identity if maps size mismatches or calib is absent
    if UNDIST_MAP1 is None:
        return frame
    if frame.shape[:2] != UNDIST_MAP1.shape[:2]:
        return frame
    return cv2.remap(frame, UNDIST_MAP1, UNDIST_MAP2, cv2.INTER_LINEAR)


# serialize GPU access so overlapping jobs cannot race the single device
gpu_lock = threading.Lock()

app = FastAPI()

# allow the browser frontend (different origin/port) to call this API cross-origin
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


def job_dir(job_id):
    # per-job directory path
    return os.path.join(JOBS_ROOT, job_id)


def write_manifest(job_id, manifest):
    # atomically persist the manifest the frontend polls
    path = os.path.join(job_dir(job_id), "manifest.json")
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(manifest, f)
    os.replace(tmp, path)


def run_depth(rgb):
    # returns per-frame min-max normalized disparity-like depth in [0,1] (larger = nearer)
    h, w = rgb.shape[:2]
    inputs = depth_processor(images=rgb, return_tensors="pt").to(device)
    with torch.no_grad():
        pred = depth_model(**inputs).predicted_depth
    depth = F.interpolate(pred.unsqueeze(1), size=(h, w), mode="bicubic", align_corners=False)
    depth = depth.squeeze().cpu().numpy().astype(np.float32)
    dmin, dmax = float(depth.min()), float(depth.max())
    return (depth - dmin) / max(dmax - dmin, 1e-6)


def run_seg(rgb):
    # returns per-pixel Cityscapes class-id map at native resolution
    h, w = rgb.shape[:2]
    inputs = seg_processor(images=rgb, return_tensors="pt").to(device)
    with torch.no_grad():
        outputs = seg_model(**inputs)
    seg = seg_processor.post_process_semantic_segmentation(outputs, target_sizes=[(h, w)])[0]
    return seg.cpu().numpy().astype(np.int32)


def back_project(d_norm, rgb, seg_rgb):
    # lift the stride-sampled grid to a point cloud using Z=1/(d_norm+eps) depth and rectified intrinsics
    h, w = d_norm.shape
    z = 1.0 / (d_norm + DEPTH_EPS)
    # use the calibrated rectified intrinsics; fall back to the frame center if calib is absent
    if UNDIST_NEWK is not None:
        fx = float(UNDIST_NEWK[0, 0])
        fy = float(UNDIST_NEWK[1, 1])
        cx = float(UNDIST_NEWK[0, 2])
        cy = float(UNDIST_NEWK[1, 2])
    else:
        fx = fy = w / 2.0
        cx, cy = w / 2.0, h / 2.0
    us, vs = np.meshgrid(np.arange(w), np.arange(h))
    x_cam = (us - cx) * z / fx
    y_cam = (vs - cy) * z / fy
    # three.js viewing frame: X right, Y up, Z toward viewer
    X = x_cam[::STRIDE, ::STRIDE].reshape(-1)
    Y = (-y_cam[::STRIDE, ::STRIDE]).reshape(-1)
    Z = (-z[::STRIDE, ::STRIDE]).reshape(-1)
    cols = rgb[::STRIDE, ::STRIDE].reshape(-1, 3).astype(np.uint8)
    labs = seg_rgb[::STRIDE, ::STRIDE].reshape(-1, 3).astype(np.uint8)
    xyz = np.stack([X, Y, Z], axis=1).astype(np.float32)
    return xyz, cols, labs


def write_cloud_bin(path, xyz, cols, labs):
    # wire format: uint32 count + f32 xyz + u8 rgb + u8 label-rgb, all little-endian
    count = xyz.shape[0]
    with open(path, "wb") as f:
        f.write(np.uint32(count).tobytes())
        f.write(xyz.astype("<f4").tobytes())
        f.write(cols.astype(np.uint8).tobytes())
        f.write(labs.astype(np.uint8).tobytes())


def sample_frames(video_path):
    # decode with cv2 (no ffmpeg) and sample ~TARGET_FPS; returns (list of BGR frames, src_fps, w, h)
    cap = cv2.VideoCapture(video_path)
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
    return frames, src_fps, w, h


def process_job(job_id, video_path):
    # background worker: extract frames, run both models per frame, write artifacts + progress
    d = job_dir(job_id)
    manifest = {"status": "processing", "n_frames": 0, "fps": TARGET_FPS,
                "width": 0, "height": 0, "progress": 0.0}
    try:
        frames, src_fps, w, h = sample_frames(video_path)
        n = len(frames)
        manifest.update({"n_frames": n, "width": w, "height": h})
        write_manifest(job_id, manifest)

        for i, raw_bgr in enumerate(frames):
            # PIPELINE STEP 0: undistort FIRST so seg, depth, and cloud all consume the same rectified frame
            bgr = undistort(raw_bgr)
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            fdir = os.path.join(d, "frames", str(i))
            os.makedirs(fdir, exist_ok=True)

            # undistorted rgb frame (nothing downstream consumes the raw frame)
            cv2.imwrite(os.path.join(fdir, "rgb.jpg"), bgr, [cv2.IMWRITE_JPEG_QUALITY, 92])

            with gpu_lock:
                d_norm = run_depth(rgb)
                seg = run_seg(rgb)

            # turbo-colorized depth visualization
            depth_u8 = (d_norm * 255.0).astype(np.uint8)
            depth_vis = cv2.applyColorMap(depth_u8, cv2.COLORMAP_TURBO)
            cv2.imwrite(os.path.join(fdir, "depth.png"), depth_vis)

            # colorized segmentation overlaid at alpha 0.5 on the RGB frame
            seg_rgb = CITYSCAPES_PALETTE_RGB[np.clip(seg, 0, len(CITYSCAPES_PALETTE_RGB) - 1)]
            seg_bgr = cv2.cvtColor(seg_rgb, cv2.COLOR_RGB2BGR)
            overlay = cv2.addWeighted(bgr, 0.5, seg_bgr, 0.5, 0.0)
            cv2.imwrite(os.path.join(fdir, "seg.png"), overlay)

            # point cloud with corrected depth->Z projection
            xyz, cols, labs = back_project(d_norm, rgb, seg_rgb)
            write_cloud_bin(os.path.join(fdir, "cloud.bin"), xyz, cols, labs)

            manifest["progress"] = float(i + 1) / float(n)
            write_manifest(job_id, manifest)

        manifest["status"] = "done"
        manifest["progress"] = 1.0
        write_manifest(job_id, manifest)
    except Exception as e:
        manifest["status"] = "error"
        manifest["error"] = f"{type(e).__name__}: {e}"
        write_manifest(job_id, manifest)
        print("JOB ERROR", job_id, manifest["error"], flush=True)


@app.post("/api/process")
async def process(video: UploadFile = File(...)):
    # accept multipart 'video', persist it, kick off background processing, return job_id
    job_id = uuid.uuid4().hex[:12]
    d = job_dir(job_id)
    os.makedirs(d, exist_ok=True)
    video_path = os.path.join(d, "input.mp4")
    with open(video_path, "wb") as f:
        f.write(await video.read())
    write_manifest(job_id, {"status": "queued", "n_frames": 0, "fps": TARGET_FPS,
                            "width": 0, "height": 0, "progress": 0.0})
    threading.Thread(target=process_job, args=(job_id, video_path), daemon=True).start()
    return JSONResponse({"job_id": job_id})


@app.get("/api/jobs/{job_id}")
async def get_job(job_id):
    # return the manifest the frontend polls
    path = os.path.join(job_dir(job_id), "manifest.json")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="job not found")
    with open(path) as f:
        return JSONResponse(json.load(f))


@app.get("/api/jobs/{job_id}/frames/{index}/{asset}")
async def get_frame_asset(job_id, index: int, asset: str):
    # serve rgb.jpg / depth.png / seg.png / cloud.bin for a frame
    if asset not in ("rgb.jpg", "depth.png", "seg.png", "cloud.bin"):
        raise HTTPException(status_code=400, detail="unknown asset")
    path = os.path.join(job_dir(job_id), "frames", str(index), asset)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="asset not found")
    media = {"rgb.jpg": "image/jpeg", "depth.png": "image/png",
             "seg.png": "image/png", "cloud.bin": "application/octet-stream"}[asset]
    return FileResponse(path, media_type=media)


@app.get("/api/health")
async def health():
    # liveness probe
    return {"ok": True, "device": device, "seg_model": SEG_MODEL_ID}
