# assemble.py - build pipeline strip and before/after demo visuals for CV twin
import cv2
import numpy as np
import os

BASE = "/home/acer01/hackathon"
OUT = os.path.join(BASE, "results", "demo")
os.makedirs(OUT, exist_ok=True)

def load(p):
    # load image, error out loudly if missing
    img = cv2.imread(p)
    if img is None:
        raise RuntimeError("failed to load: " + p)
    return img

def resize_h(img, h):
    # resize preserving aspect ratio to target height
    w = int(round(img.shape[1] * h / img.shape[0]))
    return cv2.resize(img, (w, h), interpolation=cv2.INTER_AREA)

def label_bar(width, text, bar_h=36):
    # black bar with white centered text
    bar = np.zeros((bar_h, width, 3), dtype=np.uint8)
    font = cv2.FONT_HERSHEY_SIMPLEX
    scale = 0.6
    thick = 1
    (tw, th), _ = cv2.getTextSize(text, font, scale, thick)
    x = max(4, (width - tw) // 2)
    y = (bar_h + th) // 2
    cv2.putText(bar, text, (x, y), font, scale, (255, 255, 255), thick, cv2.LINE_AA)
    return bar

def panel(img, text, h):
    # resized panel with label bar above
    r = resize_h(img, h)
    bar = label_bar(r.shape[1], text)
    return np.vstack([bar, r])

raw = load(os.path.join(BASE, "frames", "shibuya_05.png"))
depth = load(os.path.join(BASE, "results", "A2", "shibuya_05_depth.png"))
seg = load(os.path.join(BASE, "results", "A1", "shibuya_05_seg.png"))
bev = load(os.path.join(BASE, "results", "D", "bev_clean_05.png"))

# task 1: pipeline strip
H1 = 400
GUT = 8
panels = [
    panel(raw, "RAW (identity visible)", H1),
    panel(depth, "DEPTH", H1),
    panel(seg, "SEGMENTATION", H1),
    panel(bev, "PII-FREE TWIN", H1),
]
maxh = max(p.shape[0] for p in panels)
gutter = np.zeros((maxh, GUT, 3), dtype=np.uint8)
pieces = []
for i, p in enumerate(panels):
    if p.shape[0] < maxh:
        pad = np.zeros((maxh - p.shape[0], p.shape[1], 3), dtype=np.uint8)
        p = np.vstack([p, pad])
    pieces.append(p)
    if i < len(panels) - 1:
        pieces.append(gutter)
strip = np.hstack(pieces)
p1 = os.path.join(OUT, "pipeline_strip.png")
cv2.imwrite(p1, strip)

# task 2: before/after
H2 = 600
left = panel(raw, "RAW - location, faces, brands", H2)
right = panel(bev, "TWIN - anonymized: vehicles + crowd regions", H2)
maxh2 = max(left.shape[0], right.shape[0])
def padh(p, m):
    if p.shape[0] < m:
        return np.vstack([p, np.zeros((m - p.shape[0], p.shape[1], 3), dtype=np.uint8)])
    return p
left = padh(left, maxh2)
right = padh(right, maxh2)
gutter2 = np.zeros((maxh2, GUT, 3), dtype=np.uint8)
ba = np.hstack([left, gutter2, right])
p2 = os.path.join(OUT, "before_after.png")
cv2.imwrite(p2, ba)

print("pipeline_strip", strip.shape[1], "x", strip.shape[0])
print("before_after", ba.shape[1], "x", ba.shape[0])
