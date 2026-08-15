# Stage D DEFINITIVE clean single-frame digital twin for shibuya_05: fit a FLAT ground plane to the road+sidewalk depth (monocular depth makes the physically-flat road lumpy), replace those pixels with the fitted plane so the ground is a clean labeled surface, keep buildings/vegetation/movers at real per-pixel depth, place YOLO vehicles as 3D bars, and mark the anonymized crowd region WHITE -- rendered perspective (elev72) + orthographic top-down BEV
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

# Disable cuDNN: the seg mask-proto conv_transpose2d has no cuDNN engine on this GB10 build, native kernel works (same as twin_frame.py)
torch.backends.cudnn.enabled = False

FRAMES_DIR = "/work/frames"
A1_DIR = "/work/results/A1"
A2_DIR = "/work/results/A2"
MODELS_DIR = "/work/models"
OUT_DIR = "/work/results/D"
os.makedirs(OUT_DIR, exist_ok=True)

# full 10-frame temporal window (fixed camera, 1s apart), identical to twin_frame.py -- drives static mask + fixed global depth range
WINDOW = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10"]
TARGET = "05"
TARGET_IDX = WINDOW.index(TARGET)

# back-projection convention reused from twin_frame.py: 60 deg horizontal FOV, centered principal point
HORIZONTAL_FOV_DEG = 60.0
Z_NEAR = 1.0
Z_FAR = 10.0
STRIDE = 4

# top-down-ish perspective viewpoint that reveals the intersection layout (elev high enough to see the flattened ground plan)
VIEW_ELEV = 72.0
VIEW_AZIM = -72.0

# Cityscapes trainId classes whose depth is a physically FLAT ground plane -> get replaced by the fitted plane
ROAD_CLASS = 0
SIDEWALK_CLASS = 1
GROUND_CLASSES = (ROAD_CLASS, SIDEWALK_CLASS)

# Standard Cityscapes 19-class trainId palette (RGB), index == class id, identical to twin_frame.py
CITYSCAPES_PALETTE_RGB = [
    (128, 64, 128), (244, 35, 232), (70, 70, 70), (102, 102, 156), (190, 153, 153),
    (153, 153, 153), (250, 170, 30), (220, 220, 0), (107, 142, 35), (152, 251, 152),
    (70, 130, 180), (220, 20, 60), (255, 0, 0), (0, 0, 142), (0, 0, 70),
    (0, 60, 100), (0, 80, 100), (0, 0, 230), (119, 11, 32),
]
PALETTE = np.array(CITYSCAPES_PALETTE_RGB, dtype=np.uint8)

# anonymized crowd region color: WHITE, deliberately distinct from sidewalk magenta so the crowd never blends with the pink pavement
CROWD_RGB = np.array([255, 255, 255], dtype=np.float32) / 255.0

# YOLO traffic classes to place as vehicle markers (COCO ids) with per-class bright color + footprint/height in camera units
VEHICLE_CLASSES = {2: "car", 5: "bus", 7: "truck"}
VEHICLE_COLOR = {2: (1.0, 0.5, 0.0), 5: (0.0, 1.0, 1.0), 7: (1.0, 1.0, 0.0)}
VEHICLE_SIZE = {2: (0.35, 0.35, 0.6), 5: (0.7, 0.7, 1.3), 7: (0.55, 0.55, 0.95)}


def normalize_depth_to_z(depth, d_min, d_max):
    # map disparity-like depth (larger ~ nearer) to camera-space Z with a FIXED global range, identical to twin_frame.py
    d = depth.astype(np.float32)
    span = max(d_max - d_min, 1e-6)
    nearness = (d - d_min) / span
    z = Z_FAR - nearness * (Z_FAR - Z_NEAR)
    return z


def back_project(z, width, height):
    # pinhole lift under the 60 deg FOV assumption, identical to twin_frame.py
    fx = (width / 2.0) / np.tan(np.radians(HORIZONTAL_FOV_DEG) / 2.0)
    fy = fx
    cx, cy = width / 2.0, height / 2.0
    us, vs = np.meshgrid(np.arange(width), np.arange(height))
    x = (us - cx) * z / fx
    y = (vs - cy) * z / fy
    return x, y, z


def strip_axes(ax):
    # axis stripping so the render carries surface content only, identical to twin_frame.py
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

# static mask (SEG-INDEPENDENT): per-pixel temporal grayscale std, Otsu knee, identical to twin_frame.py
temporal_std = gray_stack.std(axis=0)
std_min = float(temporal_std.min())
std_max = float(temporal_std.max())
std_u8 = np.clip((temporal_std - std_min) / (std_max - std_min + 1e-12) * 255.0, 0, 255).astype(np.uint8)
otsu_u8, _ = cv2.threshold(std_u8, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
otsu_thresh = std_min + (otsu_u8 / 255.0) * (std_max - std_min)
static_mask = temporal_std < otsu_thresh

# ANCHOR: per-pixel temporal MEAN depth, static pixels pinned to it, identical to twin_frame.py -- this is the working per-pixel depth
temporal_mean_depth = depth_stack.mean(axis=0).astype(np.float32)
anchored_stack = np.stack(
    [np.where(static_mask, temporal_mean_depth, depth_stack[f]).astype(np.float32) for f in range(len(WINDOW))],
    axis=0,
)

# target-frame classid + working depth (anchored) before flattening
cid_full = classids[TARGET_IDX]
depth_work = anchored_stack[TARGET_IDX].astype(np.float32).copy()

# ROAD FLATTENING: least-squares fit depth ~= a*row + b*col + c over ROAD(0)+SIDEWALK(1) pixels, then REPLACE those pixels with the fitted plane
ground_mask = np.isin(cid_full, GROUND_CLASSES)
rows_idx, cols_idx = np.nonzero(ground_mask)
d_obs = depth_work[rows_idx, cols_idx].astype(np.float64)
A_design = np.column_stack([rows_idx.astype(np.float64), cols_idx.astype(np.float64), np.ones(rows_idx.size)])
coef, _, _, _ = np.linalg.lstsq(A_design, d_obs, rcond=None)
plane_a, plane_b, plane_c = float(coef[0]), float(coef[1]), float(coef[2])

# plane-fit quality: R2 and RMSE residual over the fitted ground pixels
d_pred = A_design @ coef
resid = d_obs - d_pred
ss_res = float(np.sum(resid ** 2))
ss_tot = float(np.sum((d_obs - d_obs.mean()) ** 2))
plane_r2 = 1.0 - ss_res / max(ss_tot, 1e-12)
plane_rmse = float(np.sqrt(ss_res / d_obs.size))

# evaluate the fitted plane over the FULL image grid and overwrite the road+sidewalk depth -> a flat ground surface
row_grid, col_grid = np.meshgrid(np.arange(H), np.arange(W), indexing="ij")
plane_full = (plane_a * row_grid + plane_b * col_grid + plane_c).astype(np.float32)
depth_flat = depth_work.copy()
depth_flat[ground_mask] = plane_full[ground_mask]

# fixed global depth range across the anchored stack (for consistency), extended to include the flattened plane extremes
global_dmin = float(min(anchored_stack.min(), depth_flat.min()))
global_dmax = float(max(anchored_stack.max(), depth_flat.max()))

# full-resolution back-projected coordinates from the FLATTENED depth -- ground plane + vehicle base sampling
z_full = normalize_depth_to_z(depth_flat, global_dmin, global_dmax)
x_full, y_full, _ = back_project(z_full, W, H)

# run YOLO segmentation once on the target frame (imgsz=1280, cudnn off), keep car/bus/truck detections only
os.makedirs(MODELS_DIR, exist_ok=True)
os.chdir(MODELS_DIR)
model = YOLO(os.path.join(MODELS_DIR, "yolo11m-seg.pt"))
frame_bgr = cv2.imread(os.path.join(FRAMES_DIR, f"shibuya_{TARGET}.png"), cv2.IMREAD_COLOR)
if frame_bgr is None:
    raise FileNotFoundError(f"Could not read target frame shibuya_{TARGET}.png")
det = model.predict(source=frame_bgr, classes=list(VEHICLE_CLASSES.keys()), imgsz=1280, conf=0.25, verbose=False)[0]

# collect per-detection: class id, integer pixel box, and 3D ground marker base from the box bottom-center pixel (through flattened depth)
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
        # box bottom-center pixel -> flattened depth -> 3D ground point (Y negated to match the plotted surface convention)
        ub = int(np.clip((bx1 + bx2) / 2.0, 0, W - 1))
        vb = int(np.clip(by2, 0, H - 1))
        vx = float(x_full[vb, ub])
        vy = float(-y_full[vb, ub])
        vz = float(z_full[vb, ub])
        vehicles.append((int(c), vx, vy, vz))
        class_counts[int(c)] += 1

# crowd region = moving pixels (inverted static mask) MINUS the vehicle boxes -> anonymized pedestrian area
mover_mask = ~static_mask
crowd_mask = mover_mask & (~vehicle_pixel_mask)

# subsample to the working grid, mirroring twin_frame.py (note the Y negation on the plotted surface)
s = STRIDE
Xg = x_full[::s, ::s]
Yg = -y_full[::s, ::s]
Zg = z_full[::s, ::s]
cid_g = cid_full[::s, ::s]
crowd_g = crowd_mask[::s, ::s]

# per-cell face color: Cityscapes label color, overridden to WHITE wherever the crowd mask is set
face_rgb = PALETTE[cid_g].astype(np.float32) / 255.0
face_rgb[crowd_g] = CROWD_RGB
face_rgba = np.concatenate([face_rgb, np.ones(face_rgb.shape[:2] + (1,), dtype=np.float32)], axis=2)

# crowd-region share of the rendered ground cells
crowd_cells = int(crowd_g.sum())
grid_cells = int(crowd_g.size)
crowd_pct = 100.0 * crowd_cells / grid_cells

# fixed global axis limits shared by both renders
xlim = (float(Xg.min()), float(Xg.max()))
ylim = (float(Yg.min()), float(Yg.max()))
zlim = (float(Zg.min()), float(Zg.max()))


def render_perspective(elev, azim, out_name):
    # render the flattened tessellated labeled ground surface + vehicle bar markers from the given perspective viewpoint, stripped, no text
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
    # orthographic top-down bird's-eye: 2D scatter of the flattened colored ground cells + vehicle markers + white crowd at their ground X,Y
    fig = plt.figure(figsize=(10, 10), dpi=100, facecolor="black")
    ax = fig.add_subplot(111)
    ax.set_facecolor("black")
    fig.patch.set_facecolor("black")
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


# render the definitive perspective twin + orthographic BEV
persp_path = render_perspective(VIEW_ELEV, VIEW_AZIM, "twin_clean_05.png")
bev_path = render_bev("bev_clean_05.png")

print("=== Stage D : DEFINITIVE clean digital twin (shibuya_05) ===")
print(f"H={H} W={W} stride={s} grid={Xg.shape}")
print(f"ground_pixels_fitted={rows_idx.size} (road+sidewalk)")
print(f"ROAD PLANE FIT depth ~= a*row + b*col + c :")
print(f"  a={plane_a:.8f}  b={plane_b:.8f}  c={plane_c:.8f}")
print(f"  R2={plane_r2:.6f}  RMSE_residual={plane_rmse:.6f}  (depth units)")
print(f"vehicles_total={len(vehicles)} by_class=" + ", ".join(f"{VEHICLE_CLASSES[c]}={class_counts[c]}" for c in VEHICLE_CLASSES))
for c, vx, vy, vz in vehicles:
    print(f"  {VEHICLE_CLASSES[c]:>5} at X={vx:.3f} Y={vy:.3f} Z={vz:.3f}")
print(f"crowd_cells={crowd_cells}/{grid_cells}  crowd_pct={crowd_pct:.3f}%")
print(f"global_depth_range_for_Z=[{global_dmin:.6f}, {global_dmax:.6f}]")
print(f"xlim={xlim} ylim={ylim} zlim={zlim}")
print(f"wrote={persp_path}")
print(f"wrote={bev_path}")
