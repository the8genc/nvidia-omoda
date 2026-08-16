# Concern: load SegFormer-B0 Cityscapes ONCE (do_resize=False) and alpha-blend the colorized seg over each RGB frame | Non-concern: quality scoring, temporal consistency | IO: reads /work/frames_dense/*.png, writes /work/results/demo/labeled_frames/<stem>.png, prints per-frame + total wall time
import os
import glob
import time
import numpy as np
import cv2
import torch
import torch.nn.functional as F
from transformers import SegformerForSemanticSegmentation, SegformerImageProcessor

IN_DIR = "/work/frames_dense"
OUT_DIR = "/work/results/demo/labeled_frames"
MODEL_ID = "nvidia/segformer-b0-finetuned-cityscapes-1024-1024"
os.makedirs(OUT_DIR, exist_ok=True)

# Standard Cityscapes 19-class trainId palette (RGB), index == argmax class id
CITYSCAPES_PALETTE_RGB = [
    (128, 64, 128), (244, 35, 232), (70, 70, 70), (102, 102, 156), (190, 153, 153),
    (153, 153, 153), (250, 170, 30), (220, 220, 0), (107, 142, 35), (152, 251, 152),
    (70, 130, 180), (220, 20, 60), (255, 0, 0), (0, 0, 142), (0, 0, 70),
    (0, 60, 100), (0, 80, 100), (0, 0, 230), (119, 11, 32),
]
PALETTE = np.array(CITYSCAPES_PALETTE_RGB, dtype=np.uint8)

device = "cuda" if torch.cuda.is_available() else "cpu"

# load the model ONCE outside the frame loop
t_load0 = time.time()
processor = SegformerImageProcessor.from_pretrained(MODEL_ID)
model = SegformerForSemanticSegmentation.from_pretrained(MODEL_ID).to(device).eval()
load_s = time.time() - t_load0

frames = sorted(glob.glob(os.path.join(IN_DIR, "*.png")))
if not frames:
    raise FileNotFoundError(f"No frames found in {IN_DIR}")

# loop over all frames reusing the single loaded model
t_loop0 = time.time()
for frame_path in frames:
    stem = os.path.splitext(os.path.basename(frame_path))[0]
    frame_bgr = cv2.imread(frame_path, cv2.IMREAD_COLOR)
    if frame_bgr is None:
        raise FileNotFoundError(f"Could not read input frame: {frame_path}")
    H, W = frame_bgr.shape[:2]
    frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)

    # feed native aspect: default 512x512 square resize destabilizes SegFormer on 16:9
    inputs = processor(images=frame_rgb, do_resize=False, return_tensors="pt").to(device)
    with torch.no_grad():
        logits = model(**inputs).logits

    # upsample coarse logits to full frame resolution before argmax
    upsampled = F.interpolate(logits, size=(H, W), mode="bilinear", align_corners=False)
    class_id_map = upsampled.argmax(dim=1)[0].to(torch.uint8).cpu().numpy()

    seg_rgb = PALETTE[class_id_map]
    seg_bgr = cv2.cvtColor(seg_rgb, cv2.COLOR_RGB2BGR)

    # labeled RGB = seg colors alpha-blended ~0.5 over the original frame
    labeled_bgr = cv2.addWeighted(frame_bgr, 0.5, seg_bgr, 0.5, 0.0)
    cv2.imwrite(os.path.join(OUT_DIR, f"{stem}.png"), labeled_bgr)

loop_s = time.time() - t_loop0
n = len(frames)
print(f"FRAMES={n}")
print(f"MODEL_LOAD_S={load_s:.3f}")
print(f"LOOP_S={loop_s:.3f}")
print(f"PER_FRAME_S={loop_s / n:.4f}")
