# Stage C surface twin -- render the depth-anchored labeled scene as a TESSELLATED CONTINUOUS SURFACE (matplotlib plot_surface, per-cell Cityscapes label color) from the SAME fixed oblique viewpoint as stream_twin.py, so adjacent pixels form a solid mesh instead of scattered dots
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

# full 10-frame temporal window (fixed camera, 1s apart), same as stream_twin.py
WINDOW = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10"]

# back-projection convention reused from stream_twin.py / render3d.py: 60 deg horizontal FOV, centered principal point
HORIZONTAL_FOV_DEG = 60.0
Z_NEAR = 1.0
Z_FAR = 10.0

# ONE fixed oblique viewpoint + working grid stride, identical to stream_twin.py so the surface registers across frames
VIEW_ELEV = 18.0
VIEW_AZIM = -72.0
STRIDE = 4
FPS = 4

# Standard Cityscapes 19-class trainId palette (RGB), index == class id, matching seg.py / stream_twin.py
CITYSCAPES_PALETTE_RGB = [
    (128, 64, 128), (244, 35, 232), (70, 70, 70), (102, 102, 156), (190, 153, 153),
    (153, 153, 153), (250, 170, 30), (220, 220, 0), (107, 142, 35), (152, 251, 152),
    (70, 130, 180), (220, 20, 60), (255, 0, 0), (0, 0, 142), (0, 0, 70),
    (0, 60, 100), (0, 80, 100), (0, 0, 230), (119, 11, 32),
]
PALETTE = np.array(CITYSCAPES_PALETTE_RGB, dtype=np.uint8)


def normalize_depth_to_z(depth, d_min, d_max):
    # map disparity-like depth (larger ~ nearer) to camera-space Z with a FIXED global range so static pixels land at identical Z in every frame, identical to stream_twin.py
    d = depth.astype(np.float32)
    span = max(d_max - d_min, 1e-6)
    nearness = (d - d_min) / span
    z = Z_FAR - nearness * (Z_FAR - Z_NEAR)
    return z


def back_project(z, width, height):
    # pinhole lift under the 60 deg FOV assumption, identical to stream_twin.py
    fx = (width / 2.0) / np.tan(np.radians(HORIZONTAL_FOV_DEG) / 2.0)
    fy = fx
    cx, cy = width / 2.0, height / 2.0
    us, vs = np.meshgrid(np.arange(width), np.arange(height))
    x = (us - cx) * z / fx
    y = (vs - cy) * z / fy
    return x, y, z


def strip_axes(ax):
    # axis stripping so the render carries surface content only, identical to stream_twin.py
    ax.set_axis_off()
    ax.grid(False)
    ax.set_xticks([])
    ax.set_yticks([])
    ax.set_zticks([])
    for pane in (ax.xaxis, ax.yaxis, ax.zaxis):
        pane.pane.set_visible(False)


# load all 10 frames: grayscale (static mask), classid maps (label color), depth maps
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

# static mask (SEG-INDEPENDENT): per-pixel temporal grayscale std, Otsu knee, identical to stream_twin.py
temporal_std = gray_stack.std(axis=0)
std_min = float(temporal_std.min())
std_max = float(temporal_std.max())
std_u8 = np.clip((temporal_std - std_min) / (std_max - std_min + 1e-12) * 255.0, 0, 255).astype(np.uint8)
otsu_u8, _ = cv2.threshold(std_u8, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
otsu_thresh = std_min + (otsu_u8 / 255.0) * (std_max - std_min)
static_mask = temporal_std < otsu_thresh
n_static = int(static_mask.sum())
pct_static = 100.0 * n_static / total_pixels

# ANCHOR: per-pixel temporal MEAN depth; static pixels pinned to this mean in EVERY frame, identical to stream_twin.py
temporal_mean_depth = depth_stack.mean(axis=0).astype(np.float32)
anchored_depths = []
for f in range(len(WINDOW)):
    anchored = np.where(static_mask, temporal_mean_depth, depth_stack[f]).astype(np.float32)
    anchored_depths.append(anchored)
anchored_stack = np.stack(anchored_depths, axis=0)

# FIXED global depth range across the whole anchored stack so depth->Z is identical for every frame, identical to stream_twin.py
global_dmin = float(anchored_stack.min())
global_dmax = float(anchored_stack.max())

# first pass: build each frame's subsampled surface grid (X, Y, Z) + per-cell facecolors, accumulate GLOBAL axis limits so viewpoint/extent is fixed
s = STRIDE
frame_grids = []
gx_min = gy_min = gz_min = np.inf
gx_max = gy_max = gz_max = -np.inf
for f in range(len(WINDOW)):
    z_full = normalize_depth_to_z(anchored_stack[f], global_dmin, global_dmax)
    x_full, y_full, _ = back_project(z_full, W, H)
    # regular grid at the working stride: vertex (i,j) keeps its back-projected X,Y and anchored Z
    Xg = x_full[::s, ::s]
    Yg = (-y_full[::s, ::s])
    Zg = z_full[::s, ::s]
    cid_g = classids[f][::s, ::s]
    # per-vertex label RGBA; plot_surface colors each quad from these, giving a solid tessellated surface
    face_rgb = PALETTE[cid_g].astype(np.float32) / 255.0
    face_rgba = np.concatenate([face_rgb, np.ones(face_rgb.shape[:2] + (1,), dtype=np.float32)], axis=2)
    frame_grids.append((Xg, Yg, Zg, face_rgba))
    gx_min = min(gx_min, float(Xg.min())); gx_max = max(gx_max, float(Xg.max()))
    gy_min = min(gy_min, float(Yg.min())); gy_max = max(gy_max, float(Yg.max()))
    gz_min = min(gz_min, float(Zg.min())); gz_max = max(gz_max, float(Zg.max()))

xlim = (gx_min, gx_max)
ylim = (gy_min, gy_max)
zlim = (gz_min, gz_max)


def render_frame(f, n, out_name):
    # render one frame as a tessellated solid surface from the fixed viewpoint + fixed limits
    Xg, Yg, Zg, face_rgba = frame_grids[f]
    fig = plt.figure(figsize=(12, 9), dpi=100, facecolor="black")
    ax = fig.add_subplot(111, projection="3d")
    ax.set_facecolor("black")
    fig.patch.set_facecolor("black")
    # tessellate: every adjacent 2x2 vertex block becomes a filled quad colored by its label; shade off so colors stay exact
    ax.plot_surface(Xg, Yg, Zg, facecolors=face_rgba, rstride=1, cstride=1,
                    linewidth=0, antialiased=False, shade=False)
    ax.view_init(elev=VIEW_ELEV, azim=VIEW_AZIM)
    ax.set_xlim(xlim)
    ax.set_ylim(ylim)
    ax.set_zlim(zlim)
    strip_axes(ax)
    fig.subplots_adjust(left=0, right=1, top=1, bottom=0)
    out_path = os.path.join(OUT_DIR, out_name)
    fig.savefig(out_path, dpi=100, facecolor="black")
    plt.close(fig)
    return out_path


# render all 10 surface frames + the two representative stripped renders (surf_03, surf_08)
frame_paths = []
for f, n in enumerate(WINDOW):
    frame_paths.append(render_frame(f, n, f"surfframe_{n}.png"))
surf03 = render_frame(2, "03", "surf_03.png")
surf08 = render_frame(7, "08", "surf_08.png")

# assemble the surface frames into an mp4 via ffmpeg if present on the host, else emit the command
mp4_path = os.path.join(OUT_DIR, "twin_surface.mp4")
pattern = os.path.join(OUT_DIR, "surfframe_%02d.png")
mp4_cmd = [
    "ffmpeg", "-y", "-framerate", str(FPS), "-start_number", "1",
    "-i", pattern, "-frames:v", str(len(WINDOW)),
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", mp4_path,
]
ffmpeg_bin = shutil.which("ffmpeg")
if ffmpeg_bin:
    subprocess.run(mp4_cmd, check=True)
    ffmpeg_status = "ffmpeg present: twin_surface.mp4 assembled in-script"
else:
    ffmpeg_status = "ffmpeg NOT in this container -- run on host:\n  " + " ".join(mp4_cmd)

print("=== Stage C : tessellated solid-surface twin ===")
print(f"frames={len(WINDOW)}  (H={H}, W={W})  stride={s}  grid={frame_grids[0][0].shape}  fps={FPS}")
print(f"otsu_threshold={otsu_thresh:.6f}  static_count={n_static}  static_pct={pct_static:.4f}%")
print(f"global_depth_range_for_Z=[{global_dmin:.6f}, {global_dmax:.6f}]")
print(f"elev={VIEW_ELEV}  azim={VIEW_AZIM}")
print(f"xlim={xlim}  ylim={ylim}  zlim={zlim}")
for p in frame_paths:
    print(f"wrote={p}")
print(f"wrote={surf03}")
print(f"wrote={surf08}")
print(ffmpeg_status)
