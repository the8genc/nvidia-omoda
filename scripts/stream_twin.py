# Concern: Stage C stabilized labeled point-cloud STREAM -- lift all 10 fixed-camera frames into label-colored 3D point clouds with a DEPTH-ANCHORED background (static pixels pinned to temporal-mean depth, movers use per-frame depth), render every frame from ONE fixed oblique viewpoint so the background registers, and assemble an mp4/gif twin stream | Non-concern: metric calibration, seg/depth quality, any "does it look like a street" verdict | IO: reads frames/shibuya_01..10.png + results/A1/<stem>_classid.npy + results/A2/<stem>_depth.npy -> writes results/C/frame_XX.png, results/C/twin_stream.mp4, results/C/twin_stream.gif, results/C/repr_03.png, results/C/repr_08.png
import os
import shutil
import subprocess
import numpy as np
import cv2
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d import Axes3D  # noqa: F401  registers the 3d projection

FRAMES_DIR = "/work/frames"
A1_DIR = "/work/results/A1"
A2_DIR = "/work/results/A2"
OUT_DIR = "/work/results/C"
os.makedirs(OUT_DIR, exist_ok=True)

# full 10-frame temporal window (fixed camera, 1s apart)
WINDOW = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10"]

# back-projection convention reused from render3d.py: assume 60 deg horizontal FOV, centered principal point
HORIZONTAL_FOV_DEG = 60.0
Z_NEAR = 1.0
Z_FAR = 10.0

# one fixed oblique camera viewpoint applied to every frame so the anchored background registers
VIEW_ELEV = 18.0
VIEW_AZIM = -72.0
STRIDE = 4
FPS = 4

# Standard Cityscapes 19-class trainId palette (RGB), index == class id, matching seg.py
CITYSCAPES_PALETTE_RGB = [
    (128, 64, 128), (244, 35, 232), (70, 70, 70), (102, 102, 156), (190, 153, 153),
    (153, 153, 153), (250, 170, 30), (220, 220, 0), (107, 142, 35), (152, 251, 152),
    (70, 130, 180), (220, 20, 60), (255, 0, 0), (0, 0, 142), (0, 0, 70),
    (0, 60, 100), (0, 80, 100), (0, 0, 230), (119, 11, 32),
]
PALETTE = np.array(CITYSCAPES_PALETTE_RGB, dtype=np.uint8)


def normalize_depth_to_z(depth, d_min, d_max):
    # map disparity-like depth (larger ~ nearer) to camera-space Z (nearer -> smaller Z) using a FIXED global range so static pixels land at identical Z in every frame
    d = depth.astype(np.float32)
    span = max(d_max - d_min, 1e-6)
    nearness = (d - d_min) / span
    z = Z_FAR - nearness * (Z_FAR - Z_NEAR)
    return z


def back_project(z, width, height):
    # reuse render3d.py's pinhole lift under the 60 deg FOV assumption
    fx = (width / 2.0) / np.tan(np.radians(HORIZONTAL_FOV_DEG) / 2.0)
    fy = fx
    cx, cy = width / 2.0, height / 2.0
    us, vs = np.meshgrid(np.arange(width), np.arange(height))
    x = (us - cx) * z / fx
    y = (vs - cy) * z / fy
    return x, y, z


def strip_axes(ax):
    # reuse render3d.py axis stripping so the render carries image content only
    ax.set_axis_off()
    ax.grid(False)
    ax.set_xticks([])
    ax.set_yticks([])
    ax.set_zticks([])
    for pane in (ax.xaxis, ax.yaxis, ax.zaxis):
        pane.pane.set_visible(False)


# load all 10 frames: grayscale (for static mask), classid maps (for label color), depth maps
grays = []
classids = []
depths = []
for n in WINDOW:
    bgr = cv2.imread(os.path.join(FRAMES_DIR, f"shibuya_{n}.png"))
    if bgr is None:
        raise FileNotFoundError(f"Could not read frame shibuya_{n}.png")
    grays.append(cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).astype(np.float64))
    cid = np.load(os.path.join(A1_DIR, f"shibuya_{n}_classid.npy"))
    classids.append(cid)
    d = np.load(os.path.join(A2_DIR, f"shibuya_{n}_depth.npy")).astype(np.float32)
    depths.append(d)

gray_stack = np.stack(grays, axis=0)
depth_stack = np.stack(depths, axis=0)
H, W = gray_stack.shape[1:]
total_pixels = H * W

# static mask (SEG-INDEPENDENT): per-pixel temporal grayscale std over the 10-frame window, Otsu knee, as in bg_static_anchor.py
temporal_std = gray_stack.std(axis=0)
std_min = float(temporal_std.min())
std_max = float(temporal_std.max())
std_u8 = np.clip((temporal_std - std_min) / (std_max - std_min + 1e-12) * 255.0, 0, 255).astype(np.uint8)
otsu_u8, _ = cv2.threshold(std_u8, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
otsu_thresh = std_min + (otsu_u8 / 255.0) * (std_max - std_min)
static_mask = temporal_std < otsu_thresh
mover_mask = ~static_mask
n_static = int(static_mask.sum())
pct_static = 100.0 * n_static / total_pixels

# ANCHOR: per-pixel temporal MEAN depth over the window; static pixels are pinned to this mean in EVERY frame
temporal_mean_depth = depth_stack.mean(axis=0).astype(np.float32)

# build the anchored depth per frame: static -> fixed temporal mean, mover -> that frame's own depth
anchored_depths = []
for f in range(len(WINDOW)):
    anchored = np.where(static_mask, temporal_mean_depth, depth_stack[f]).astype(np.float32)
    anchored_depths.append(anchored)
anchored_stack = np.stack(anchored_depths, axis=0)

# FIXED global depth range across the whole anchored stack so the depth->Z mapping is identical for every frame
global_dmin = float(anchored_stack.min())
global_dmax = float(anchored_stack.max())

# first pass: build every frame's subsampled point cloud + colors, and accumulate GLOBAL axis limits so the viewpoint/extent is fixed
s = STRIDE
frame_clouds = []
gx_min = gy_min = gz_min = np.inf
gx_max = gy_max = gz_max = -np.inf
for f in range(len(WINDOW)):
    z_full = normalize_depth_to_z(anchored_stack[f], global_dmin, global_dmax)
    x_full, y_full, _ = back_project(z_full, W, H)
    xs = x_full[::s, ::s].reshape(-1)
    # invert Y so image-down maps to visual-down, matching render3d.py
    ys_plot = (-y_full[::s, ::s]).reshape(-1)
    zs = z_full[::s, ::s].reshape(-1)
    cid_sub = classids[f][::s, ::s].reshape(-1)
    colors = (PALETTE[cid_sub].astype(np.float32) / 255.0)
    frame_clouds.append((xs, ys_plot, zs, colors))
    gx_min = min(gx_min, float(xs.min())); gx_max = max(gx_max, float(xs.max()))
    gy_min = min(gy_min, float(ys_plot.min())); gy_max = max(gy_max, float(ys_plot.max()))
    gz_min = min(gz_min, float(zs.min())); gz_max = max(gz_max, float(zs.max()))

xlim = (gx_min, gx_max)
ylim = (gy_min, gy_max)
zlim = (gz_min, gz_max)

# second pass: render every frame from the SAME fixed viewpoint + SAME fixed limits (no tight-bbox crop, so the canvas is identical frame-to-frame and the background registers)
frame_paths = []
for f, n in enumerate(WINDOW):
    xs, ys_plot, zs, colors = frame_clouds[f]
    fig = plt.figure(figsize=(12, 9), dpi=100)
    ax = fig.add_subplot(111, projection="3d")
    ax.scatter(xs, ys_plot, zs, c=colors, s=1.0, marker=".", linewidths=0)
    ax.view_init(elev=VIEW_ELEV, azim=VIEW_AZIM)
    ax.set_xlim(xlim)
    ax.set_ylim(ylim)
    ax.set_zlim(zlim)
    strip_axes(ax)
    fig.subplots_adjust(left=0, right=1, top=1, bottom=0)
    out_path = os.path.join(OUT_DIR, f"frame_{n}.png")
    fig.savefig(out_path, dpi=100, facecolor="black")
    plt.close(fig)
    frame_paths.append(out_path)

# representative single-frame renders for blind gating (stripped, no text) -- copy frames 03 and 08
shutil.copyfile(os.path.join(OUT_DIR, "frame_03.png"), os.path.join(OUT_DIR, "repr_03.png"))
shutil.copyfile(os.path.join(OUT_DIR, "frame_08.png"), os.path.join(OUT_DIR, "repr_08.png"))

# assemble the per-frame PNGs into an mp4 (and gif) via ffmpeg if present; otherwise emit the exact commands to run on a host that has it
mp4_path = os.path.join(OUT_DIR, "twin_stream.mp4")
gif_path = os.path.join(OUT_DIR, "twin_stream.gif")
pattern = os.path.join(OUT_DIR, "frame_%02d.png")
mp4_cmd = [
    "ffmpeg", "-y", "-framerate", str(FPS), "-start_number", "1",
    "-i", pattern, "-frames:v", str(len(WINDOW)),
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", mp4_path,
]
gif_cmd = [
    "ffmpeg", "-y", "-framerate", str(FPS), "-start_number", "1",
    "-i", pattern, "-frames:v", str(len(WINDOW)), gif_path,
]
ffmpeg_bin = shutil.which("ffmpeg")
if ffmpeg_bin:
    subprocess.run(mp4_cmd, check=True)
    subprocess.run(gif_cmd, check=True)
    ffmpeg_status = "ffmpeg present: mp4+gif assembled in-script"
else:
    ffmpeg_status = "ffmpeg NOT in this environment -- run these on a host with ffmpeg:\n  " + " ".join(mp4_cmd) + "\n  " + " ".join(gif_cmd)

print("=== Stage C : stabilized labeled point-cloud STREAM ===")
print(f"frames={len(WINDOW)}  (H={H}, W={W})  stride={s}  fps={FPS}")
print("--- static mask (per-pixel temporal grayscale std, Otsu knee) ---")
print(f"otsu_threshold={otsu_thresh:.6f}")
print(f"static_count={n_static}  static_pct={pct_static:.4f}%")
print("--- depth anchor ---")
print(f"static pixels pinned to per-pixel temporal MEAN depth; movers use per-frame depth")
print(f"global_depth_range_for_Z=[{global_dmin:.6f}, {global_dmax:.6f}]  (fixed across all frames)")
print("--- fixed viewpoint ---")
print(f"elev={VIEW_ELEV}  azim={VIEW_AZIM}")
print(f"xlim={xlim}  ylim={ylim}  zlim={zlim}")
print(f"points_per_frame={frame_clouds[0][0].size}")
print("--- artifacts ---")
for p in frame_paths:
    print(f"wrote={p}")
print(f"wrote={os.path.join(OUT_DIR, 'repr_03.png')}")
print(f"wrote={os.path.join(OUT_DIR, 'repr_08.png')}")
print(ffmpeg_status)
