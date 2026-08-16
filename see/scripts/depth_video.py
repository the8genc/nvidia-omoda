# Concern: load Depth-Anything-V2-Small ONCE and produce a native-res turbo depth PNG for every frame in frames_dense | Non-concern: temporal smoothing, metric scale | IO: reads /work/frames_dense/*.png, writes /work/results/demo/depth_frames/<stem>.png, prints per-frame + total wall time
import os
import glob
import time
import numpy as np
import torch
import torch.nn.functional as F
import cv2
from transformers import AutoModelForDepthEstimation, AutoImageProcessor

IN_DIR = "/work/frames_dense"
OUT_DIR = "/work/results/demo/depth_frames"
os.makedirs(OUT_DIR, exist_ok=True)

# cuDNN lacks a conv_transpose2d engine for this GPU/arch; fall back to the native kernel
torch.backends.cudnn.enabled = False

device = "cuda" if torch.cuda.is_available() else "cpu"

# load the model ONCE outside the frame loop
t_load0 = time.time()
processor = AutoImageProcessor.from_pretrained("depth-anything/Depth-Anything-V2-Small-hf")
model = AutoModelForDepthEstimation.from_pretrained("depth-anything/Depth-Anything-V2-Small-hf").to(device).eval()
load_s = time.time() - t_load0

frames = sorted(glob.glob(os.path.join(IN_DIR, "*.png")))
if not frames:
    raise FileNotFoundError(f"No frames found in {IN_DIR}")

# loop over all frames reusing the single loaded model
t_loop0 = time.time()
for frame_path in frames:
    stem = os.path.splitext(os.path.basename(frame_path))[0]
    bgr = cv2.imread(frame_path)
    if bgr is None:
        raise FileNotFoundError(f"Could not read input frame: {frame_path}")
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    H, W = rgb.shape[:2]

    inputs = processor(images=rgb, return_tensors="pt").to(device)
    with torch.no_grad():
        predicted_depth = model(**inputs).predicted_depth

    # bicubic upsample raw prediction to native frame resolution
    depth = F.interpolate(predicted_depth.unsqueeze(1), size=(H, W), mode="bicubic", align_corners=False)
    depth = depth.squeeze().cpu().numpy().astype(np.float32)

    # per-frame min/max normalization for the visualization
    dmin, dmax = float(depth.min()), float(depth.max())
    norm = (depth - dmin) / (dmax - dmin + 1e-8)
    depth_u8 = (norm * 255.0).astype(np.uint8)

    # turbo colormap; cv2 emits BGR which imwrite expects
    turbo_bgr = cv2.applyColorMap(depth_u8, cv2.COLORMAP_TURBO)
    cv2.imwrite(os.path.join(OUT_DIR, f"{stem}.png"), turbo_bgr)

loop_s = time.time() - t_loop0
n = len(frames)
print(f"FRAMES={n}")
print(f"MODEL_LOAD_S={load_s:.3f}")
print(f"LOOP_S={loop_s:.3f}")
print(f"PER_FRAME_S={loop_s / n:.4f}")
