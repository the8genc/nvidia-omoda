# Concern: SegFormer-b0 Cityscapes semantic segmentation of one urban frame into a stripped colorized map + debug overlay + class distribution | Non-concern: quality judgement, multi-frame batching, model finetuning | IO: reads /work/frames/shibuya_05.png -> writes /work/results/A1/shibuya_05_seg.png, /work/results/A1/shibuya_05_overlay.png, stdout class-% table

import os
import numpy as np
import cv2
import torch
import torch.nn.functional as F
from transformers import SegformerForSemanticSegmentation, SegformerImageProcessor

INPUT_PATH = "/work/frames/shibuya_05.png"
OUTPUT_DIR = "/work/results/A1"
SEG_PATH = os.path.join(OUTPUT_DIR, "shibuya_05_seg.png")
OVERLAY_PATH = os.path.join(OUTPUT_DIR, "shibuya_05_overlay.png")
MODEL_ID = "nvidia/segformer-b0-finetuned-cityscapes-1024-1024"

# Standard Cityscapes 19-class trainId palette (RGB), index == argmax class id
CITYSCAPES_CLASS_NAMES = [
    "road", "sidewalk", "building", "wall", "fence", "pole",
    "traffic light", "traffic sign", "vegetation", "terrain", "sky",
    "person", "rider", "car", "truck", "bus", "train", "motorcycle", "bicycle",
]
CITYSCAPES_PALETTE_RGB = [
    (128, 64, 128), (244, 35, 232), (70, 70, 70), (102, 102, 156), (190, 153, 153),
    (153, 153, 153), (250, 170, 30), (220, 220, 0), (107, 142, 35), (152, 251, 152),
    (70, 130, 180), (220, 20, 60), (255, 0, 0), (0, 0, 142), (0, 0, 70),
    (0, 60, 100), (0, 80, 100), (0, 0, 230), (119, 11, 32),
]


def colorize(class_id_map):
    # Map each per-pixel class id to its palette RGB via a lookup table
    palette = np.array(CITYSCAPES_PALETTE_RGB, dtype=np.uint8)
    return palette[class_id_map]


os.makedirs(OUTPUT_DIR, exist_ok=True)

device = "cuda" if torch.cuda.is_available() else "cpu"

frame_bgr = cv2.imread(INPUT_PATH, cv2.IMREAD_COLOR)
if frame_bgr is None:
    raise FileNotFoundError(f"Could not read input frame: {INPUT_PATH}")
frame_height, frame_width = frame_bgr.shape[:2]
frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)

processor = SegformerImageProcessor.from_pretrained(MODEL_ID)
model = SegformerForSemanticSegmentation.from_pretrained(MODEL_ID).to(device).eval()

inputs = processor(images=frame_rgb, return_tensors="pt").to(device)
with torch.no_grad():
    logits = model(**inputs).logits

# Upsample coarse logits to full frame resolution before argmax
upsampled_logits = F.interpolate(
    logits, size=(frame_height, frame_width), mode="bilinear", align_corners=False
)
class_id_map = upsampled_logits.argmax(dim=1)[0].to(torch.uint8).cpu().numpy()

seg_rgb = colorize(class_id_map)
seg_bgr = cv2.cvtColor(seg_rgb, cv2.COLOR_RGB2BGR)
cv2.imwrite(SEG_PATH, seg_bgr)

overlay_bgr = cv2.addWeighted(frame_bgr, 0.5, seg_bgr, 0.5, 0.0)
cv2.imwrite(OVERLAY_PATH, overlay_bgr)

total_pixels = class_id_map.size
counts = np.bincount(class_id_map.reshape(-1), minlength=len(CITYSCAPES_CLASS_NAMES))
rows = [
    (CITYSCAPES_CLASS_NAMES[class_id], 100.0 * count / total_pixels)
    for class_id, count in enumerate(counts)
    if count > 0
]
rows.sort(key=lambda row: row[1], reverse=True)

print(f"Frame: {INPUT_PATH} ({frame_width}x{frame_height})")
print(f"Device: {device}")
print("Per-class pixel percentage (descending):")
for class_name, percentage in rows:
    print(f"{class_name}: {percentage:.4f}%")
