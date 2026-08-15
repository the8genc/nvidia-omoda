# Stage D populated single-frame digital twin for shibuya_08: reuse the Stage C tessellated depth-anchored labeled GROUND surface, place YOLO-detected VEHICLES as bright 3D bar markers back-projected onto that surface, and recolor the moving-but-not-vehicle ground cells as an anonymized CROWD region -- rendered from a more top-down viewpoint that reveals the intersection layout
import os

# Pin ultralytics/torch/matplotlib cache + config writes under /work so nothing touches HOME
os.environ["YOLO_CONFIG_DIR"] = "/tmp/Ultralytics"
os.environ["MPLCONFIGDIR"] = "/work/mpl_cfg"
os.environ["TORCH_HOME"] = "/work/torch_home"

import numpy as np
import cv2
import torch
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d import Axes3D  # noqa: F401  registers the 3d projection
from ultralytics import YOLO

# Disable cuDNN: the seg mask-proto conv_transpose2d has no cuDNN engine on this GB10 build, native kernel works (same as detect_track.py)
torch.backends.cudnn.enabled = False

FRAMES_DIR = "/work/frames"
A1_DIR = "/work/results/A1"
A2_DIR = "/work/results/A2"
MODELS_DIR = "/work/models"
OUT_DIR = "/work/results/D"
os.makedirs(OUT_DIR, exist_ok=True)

# full 10-frame temporal window (fixed camera, 1s apart), identical to render_surface.py -- drives anchor + static mask
WINDOW = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10"]
TARGET = "08"
TARGET_IDX = WINDOW.index(TARGET)

# back-projection convention reused from render_surface.py: 60 deg horizontal FOV, centered principal point
HORIZONTAL_FOV_DEG = 60.0
Z_NEAR = 1.0
Z_FAR = 10.0
STRIDE = 4

# candidate more-top-down viewpoints to reveal the road/crosswalk layout (Stage C used elev=18 which views the flat ground edge-on)
VIEW_A = (72.0, -72.0)
VIEW_B = (55.0, -72.0)

# Standard Cityscapes 19-class trainId palette (RGB), index == class id, identical to render_surface.py
CITYSCAPES_PALETTE_RGB = [
    (128, 64, 128), (244, 35, 232), (70, 70, 70), (102, 102, 156), (190, 153, 153),
    (153, 153, 153), (250, 170, 30), (220, 220, 0), (107, 142, 35), (152, 251, 152),
    (70, 130, 180), (220, 20, 60), (255, 0, 0), (0, 0, 142), (0, 0, 70),
    (0, 60, 100), (0, 80, 100), (0, 0, 230), (119, 11, 32),
]
PALETTE = np.array(CITYSCAPES_PALETTE_RGB, dtype=np.uint8)

# anonymized crowd region color (bright hot-pink, distinct from every Cityscapes label) -- PII-safe area, not individuals
CROWD_RGB = np.array([255, 0, 255], dtype=np.float32) / 255.0

# YOLO traffic classes to place as vehicle markers (COCO ids) with per-class bright marker color + footprint/height in camera units
VEHICLE_CLASSES = {2: "car", 5: "bus", 7: "truck"}
VEHICLE_COLOR = {2: (1.0, 0.5, 0.0), 5: (0.0, 1.0, 1.0), 7: (1.0, 1.0, 0.0)}
VEHICLE_SIZE = {2: (0.35, 0.35, 0.6), 5: (0.7, 0.7, 1.3), 7: (0.55, 0.55, 0.95)}


def normalize_depth_to_z(depth, d_min, d_max):
    # map disparity-like depth (larger ~ nearer) to camera-space Z with a FIXED global range, identical to render_surface.py
    d = depth.astype(np.float32)
    span = max(d_max - d_min, 1e-6)
    nearness = (d - d_min) / span
    z = Z_FAR - nearness * (Z_FAR - Z_NEAR)
    return z


def back_project(z, width, height):
    # pinhole lift under the 60 deg FOV assumption, identical to render_surface.py
    fx = (width / 2.0) / np.tan(np.radians(HORIZONTAL_FOV_DEG) / 2.0)
    fy = fx
    cx, cy = width / 2.0, height / 2.0
    us, vs = np.meshgrid(np.arange(width), np.arange(height))
    x = (us - cx) * z / fx
    y = (vs - cy) * z / fy
    return x, y, z


def strip_axes(ax):
    # axis stripping so the render carries surface content only, identical to render_surface.py
    ax.set_axis_off()
    ax.grid(False)
    ax.set_xticks([])
    ax.set_yticks([])
    ax.set_zticks([])
    for pane in (ax.xaxis, ax.yaxis, ax.zaxis):
        pane.pane.set_visible(False)


# load the 10-frame window: grayscale (static mask), classid maps (label color), depth maps
grays = []
classids = []
depths = []
for n in WINDOW:
    bgr = cv2.imread(os.path.join(FRAMES_DIR, f"shibuya_{n}.png"))
    if bgr is None:
        raise FileNotFoundError(f"Could not read frame shibuya_{n}.png")
    grays.append(cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).astype(np.float64))
    classids.append(np.load(os.path.join(A1_DIR, f"shibuya_{n}_classid.npy")))
    depths.append(np.load(os.path.join(A2_DIR, f"shibuya_{n}_depth.npy")).astype(np.float32))

gray_stack = np.stack(grays, axis=0)
depth_stack = np.stack(depths, axis=0)
H, W = gray_stack.shape[1:]
total_pixels = H * W

# static mask (SEG-INDEPENDENT): per-pixel temporal grayscale std, Otsu knee, identical to render_surface.py
temporal_std = gray_stack.std(axis=0)
std_min = float(temporal_std.min())
std_max = float(temporal_std.max())
std_u8 = np.clip((temporal_std - std_min) / (std_max - std_min + 1e-12) * 255.0, 0, 255).astype(np.uint8)
otsu_u8, _ = cv2.threshold(std_u8, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
otsu_thresh = std_min + (otsu_u8 / 255.0) * (std_max - std_min)
static_mask = temporal_std < otsu_thresh

# ANCHOR: per-pixel temporal MEAN depth, static pixels pinned to it, identical to render_surface.py
temporal_mean_depth = depth_stack.mean(axis=0).astype(np.float32)
anchored_stack = np.stack(
    [np.where(static_mask, temporal_mean_depth, depth_stack[f]).astype(np.float32) for f in range(len(WINDOW))],
    axis=0,
)
global_dmin = float(anchored_stack.min())
global_dmax = float(anchored_stack.max())

# full-resolution back-projected coordinates for the TARGET frame (anchored depth) -- ground surface + vehicle base sampling
z_full = normalize_depth_to_z(anchored_stack[TARGET_IDX], global_dmin, global_dmax)
x_full, y_full, _ = back_project(z_full, W, H)

# run YOLO segmentation once on the target frame, keep car/bus/truck detections only
os.makedirs(MODELS_DIR, exist_ok=True)
os.chdir(MODELS_DIR)
model = YOLO(os.path.join(MODELS_DIR, "yolo11m-seg.pt"))
frame_bgr = cv2.imread(os.path.join(FRAMES_DIR, f"shibuya_{TARGET}.png"), cv2.IMREAD_COLOR)
if frame_bgr is None:
    raise FileNotFoundError(f"Could not read target frame shibuya_{TARGET}.png")
det = model.predict(source=frame_bgr, classes=list(VEHICLE_CLASSES.keys()), imgsz=1280, conf=0.25, verbose=False)[0]

# collect per-detection: class id, integer pixel box, and 3D ground marker base from the box bottom-center pixel
vehicle_pixel_mask = np.zeros((H, W), dtype=bool)
vehicles = []
class_counts = {c: 0 for c in VEHICLE_CLASSES}
if det.boxes is not None and len(det.boxes) > 0:
    cls_arr = det.boxes.cls.cpu().numpy().astype(int)
    xyxy = det.boxes.xyxy.cpu().numpy()
    for c, (bx1, by1, bx2, by2) in zip(cls_arr, xyxy):
        if c not in VEHICLE_CLASSES:
            continue
        ix1 = int(np.clip(bx1, 0, W - 1)); ix2 = int(np.clip(bx2, 0, W - 1))
        iy1 = int(np.clip(by1, 0, H - 1)); iy2 = int(np.clip(by2, 0, H - 1))
        vehicle_pixel_mask[iy1:iy2 + 1, ix1:ix2 + 1] = True
        # box bottom-center pixel -> anchored depth -> 3D ground point (Y negated to match the plotted surface convention)
        ub = int(np.clip((bx1 + bx2) / 2.0, 0, W - 1))
        vb = int(np.clip(by2, 0, H - 1))
        vx = float(x_full[vb, ub])
        vy = float(-y_full[vb, ub])
        vz = float(z_full[vb, ub])
        vehicles.append((int(c), vx, vy, vz))
        class_counts[int(c)] += 1

# crowd region = moving pixels (inverted static mask) MINUS the vehicle boxes -> anonymized area of pedestrians
mover_mask = ~static_mask
crowd_mask = mover_mask & (~vehicle_pixel_mask)

# subsample to the working grid, mirroring render_surface.py (note the Y negation on the plotted surface)
s = STRIDE
Xg = x_full[::s, ::s]
Yg = -y_full[::s, ::s]
Zg = z_full[::s, ::s]
cid_g = classids[TARGET_IDX][::s, ::s]
crowd_g = crowd_mask[::s, ::s]

# per-cell face color: Cityscapes label color, overridden to the crowd color wherever the crowd mask is set
face_rgb = PALETTE[cid_g].astype(np.float32) / 255.0
face_rgb[crowd_g] = CROWD_RGB
face_rgba = np.concatenate([face_rgb, np.ones(face_rgb.shape[:2] + (1,), dtype=np.float32)], axis=2)

# crowd-region share of the ground cells (over the rendered grid)
crowd_cells = int(crowd_g.sum())
grid_cells = int(crowd_g.size)
crowd_pct = 100.0 * crowd_cells / grid_cells

# fixed global axis limits so both viewpoints share extent
xlim = (float(Xg.min()), float(Xg.max()))
ylim = (float(Yg.min()), float(Yg.max()))
zlim = (float(Zg.min()), float(Zg.max()))


def render(elev, azim, out_name):
    # render the tessellated labeled ground surface + vehicle bar markers from the given viewpoint, stripped, no text
    fig = plt.figure(figsize=(12, 9), dpi=100, facecolor="black")
    ax = fig.add_subplot(111, projection="3d")
    ax.set_facecolor("black")
    fig.patch.set_facecolor("black")
    ax.plot_surface(Xg, Yg, Zg, facecolors=face_rgba, rstride=1, cstride=1,
                    linewidth=0, antialiased=False, shade=False)
    # each vehicle is an axis-aligned bar standing up (+Z) from its ground contact point, bright per-class color
    for c, vx, vy, vz in vehicles:
        dx, dy, dz = VEHICLE_SIZE[c]
        ax.bar3d(vx - dx / 2.0, vy - dy / 2.0, vz, dx, dy, dz,
                 color=VEHICLE_COLOR[c], shade=True, zsort="max")
    ax.view_init(elev=elev, azim=azim)
    ax.set_xlim(xlim)
    ax.set_ylim(ylim)
    ax.set_zlim(zlim)
    strip_axes(ax)
    fig.subplots_adjust(left=0, right=1, top=1, bottom=0)
    out_path = os.path.join(OUT_DIR, out_name)
    fig.savefig(out_path, dpi=100, facecolor="black")
    plt.close(fig)
    return out_path


def render_bev(out_name):
    # orthographic top-down bird's-eye: 2D scatter of the colored ground cells + vehicle markers at their ground X,Y
    fig = plt.figure(figsize=(10, 10), dpi=100, facecolor="black")
    ax = fig.add_subplot(111)
    ax.set_facecolor("black")
    ax.scatter(Xg.ravel(), Yg.ravel(), c=face_rgb.reshape(-1, 3), s=6, marker="s", linewidths=0)
    for c, vx, vy, vz in vehicles:
        ax.scatter([vx], [vy], c=[VEHICLE_COLOR[c]], s=140, marker="s", edgecolors="black", linewidths=0.8)
    ax.set_xlim(xlim)
    ax.set_ylim(ylim)
    ax.set_aspect("equal")
    ax.set_axis_off()
    fig.subplots_adjust(left=0, right=1, top=1, bottom=0)
    out_path = os.path.join(OUT_DIR, out_name)
    fig.savefig(out_path, dpi=100, facecolor="black")
    plt.close(fig)
    return out_path


# render both candidate viewpoints and the BEV; primary/alt selection is reported after visual inspection
pathA = render(VIEW_A[0], VIEW_A[1], "twin_08_viewA_elev72.png")
pathB = render(VIEW_B[0], VIEW_B[1], "twin_08_viewB_elev55.png")
bev_path = render_bev("bev_08.png")

print("=== Stage D : populated single-frame digital twin (shibuya_08) ===")
print(f"H={H} W={W} stride={s} grid={Xg.shape}")
print(f"vehicles_total={len(vehicles)} by_class=" + ", ".join(f"{VEHICLE_CLASSES[c]}={class_counts[c]}" for c in VEHICLE_CLASSES))
for c, vx, vy, vz in vehicles:
    print(f"  {VEHICLE_CLASSES[c]:>5} at X={vx:.3f} Y={vy:.3f} Z={vz:.3f}")
print(f"crowd_cells={crowd_cells}/{grid_cells}  crowd_pct={crowd_pct:.3f}%")
print(f"xlim={xlim} ylim={ylim} zlim={zlim}")
print(f"wrote={pathA}")
print(f"wrote={pathB}")
print(f"wrote={bev_path}")
