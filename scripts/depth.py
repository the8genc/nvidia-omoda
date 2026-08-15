# Concern: monocular depth (Depth-Anything-V2-Small) on one frame + raw/vis artifacts + convention stats | Non-concern: multi-frame, temporal, metric-scale calibration | IO: reads frames/shibuya_05.png, writes results/A2/shibuya_05_depth.{npy,png}, prints stats
import os
import numpy as np
import torch
import torch.nn.functional as F
import cv2
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from transformers import AutoModelForDepthEstimation, AutoImageProcessor

FRAME = "/work/frames/shibuya_05.png"
OUT_DIR = "/work/results/A2"
os.makedirs(OUT_DIR, exist_ok=True)

# cv2 loads BGR; convert to RGB for the HF processor
bgr = cv2.imread(FRAME)
rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
H, W = rgb.shape[:2]

# cuDNN lacks a conv_transpose2d engine for this GPU/arch; fall back to the native kernel
torch.backends.cudnn.enabled = False

device = "cuda" if torch.cuda.is_available() else "cpu"
processor = AutoImageProcessor.from_pretrained("depth-anything/Depth-Anything-V2-Small-hf")
model = AutoModelForDepthEstimation.from_pretrained("depth-anything/Depth-Anything-V2-Small-hf").to(device).eval()

inputs = processor(images=rgb, return_tensors="pt").to(device)
with torch.no_grad():
    predicted_depth = model(**inputs).predicted_depth

# bicubic interpolate the raw prediction up to native frame resolution
depth = F.interpolate(predicted_depth.unsqueeze(1), size=(H, W), mode="bicubic", align_corners=False)
depth = depth.squeeze().cpu().numpy().astype(np.float32)

np.save(os.path.join(OUT_DIR, "shibuya_05_depth.npy"), depth)

# normalize to this frame's own min/max for the visualization only
dmin, dmax, dmean = float(depth.min()), float(depth.max()), float(depth.mean())
norm = (depth - dmin) / (dmax - dmin + 1e-8)

# stripped artifact: image content only, no axes/colorbar/text/margins
fig = plt.figure(figsize=(W / 100.0, H / 100.0), dpi=100)
ax = plt.Axes(fig, [0.0, 0.0, 1.0, 1.0])
ax.set_axis_off()
fig.add_axes(ax)
ax.imshow(norm, cmap="turbo", aspect="auto")
fig.savefig(os.path.join(OUT_DIR, "shibuya_05_depth.png"), dpi=100)
plt.close(fig)

# convention check: mean over top 10% rows vs bottom 10% rows of the frame
n_rows = max(1, int(round(0.10 * H)))
top_mean = float(depth[:n_rows, :].mean())
bottom_mean = float(depth[H - n_rows:, :].mean())

print(f"DEPTH_MIN={dmin:.6f}")
print(f"DEPTH_MAX={dmax:.6f}")
print(f"DEPTH_MEAN={dmean:.6f}")
print(f"TOP10_ROWS_MEAN={top_mean:.6f}")
print(f"BOTTOM10_ROWS_MEAN={bottom_mean:.6f}")
# Depth-Anything emits a disparity-like value: higher = nearer, lower = farther
near_end = "MAX" if bottom_mean > top_mean else "MIN"
far_end = "MIN" if near_end == "MAX" else "MAX"
print(f"CONVENTION: higher_value=NEAR, lower_value=FAR (disparity-like)")
print(f"OBSERVED: bottom_rows({bottom_mean:.4f}) vs top_rows({top_mean:.4f}) -> NEAR end = {near_end} of value range, FAR end = {far_end}")
