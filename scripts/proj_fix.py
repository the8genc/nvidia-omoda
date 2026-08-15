# Concern: prove the monocular back-projection bug -- Depth-Anything emits DISPARITY (larger=nearer), so using Z linear in that value hyperbolically bowls a flat road; fix is Z=1/(d_norm+eps) true depth. Builds the road point cloud both ways, fits a plane to road (class 0) pixels, reports normal-residual planarity, and renders grazing + 3/4 views. | Non-concern: metric scale, camera calibration, segmentation quality | IO: reads /work/results/A2/shibuya_05_depth.npy + /work/frames/shibuya_05.png + /work/results/A1/shibuya_05_classid.npy -> writes /work/results/proj_fix/road_{old,new}_{grazing,persp}.png
import os
import numpy as np
import cv2
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d import Axes3D  # noqa: F401  registers the 3d projection

STEM = "shibuya_05"
DEPTH_NPY = f"/work/results/A2/{STEM}_depth.npy"
FRAME_PNG = f"/work/frames/{STEM}.png"
CLASS_NPY = f"/work/results/A1/{STEM}_classid.npy"
OUT_DIR = "/work/results/proj_fix"
ROAD_CLASS = 0

# monocular lift carries no intrinsics: assume 60 deg horizontal FOV, centered principal point
HORIZONTAL_FOV_DEG = 60.0
STRIDE = 4

# OLD (buggy) convention from render3d.py / stream_twin.py: Z linear in normalized disparity
Z_NEAR = 1.0
Z_FAR = 10.0

# NEW convention: treat Depth-Anything value as disparity, invert to true depth
EPS = 0.05


def normalize(d):
    # scale raw disparity-like depth to [0,1]; larger = nearer
    d = d.astype(np.float32)
    dmin, dmax = float(d.min()), float(d.max())
    return (d - dmin) / max(dmax - dmin, 1e-6)


def z_old(d_norm):
    # BUG: map disparity linearly to camera Z (nearer -> smaller Z). Warps a flat road into a bowl.
    return Z_FAR - d_norm * (Z_FAR - Z_NEAR)


def z_new(d_norm):
    # FIX: disparity d ~ 1/Z, so true depth Z = 1/(d_norm + eps) up to global scale
    return 1.0 / (d_norm + EPS)


def back_project(z):
    # pinhole lift under the 60 deg FOV assumption; returns world frame X=right, Y=depth(into scene), Zup=up
    height, width = z.shape
    fx = (width / 2.0) / np.tan(np.radians(HORIZONTAL_FOV_DEG) / 2.0)
    fy = fx
    cx, cy = width / 2.0, height / 2.0
    us, vs = np.meshgrid(np.arange(width), np.arange(height))
    x_cam = (us - cx) * z / fx
    y_cam = (vs - cy) * z / fy
    # world frame for intuitive rendering: right, depth-into-scene, up(=-y_cam)
    return x_cam, z, -y_cam


def fit_plane_residual(pts):
    # least-squares plane via PCA: smallest principal axis is the plane normal
    c = pts.mean(axis=0)
    q = pts - c
    u, s, vt = np.linalg.svd(q, full_matrices=False)
    normal = vt[-1]
    resid = q @ normal
    rms = float(np.sqrt(np.mean(resid ** 2)))
    # in-plane extent = RMS spread within the two dominant plane axes
    inplane = q @ vt[:2].T
    extent = float(np.sqrt(np.mean(np.sum(inplane ** 2, axis=1))))
    return rms, extent, rms / max(extent, 1e-9)


def strip_axes(ax):
    ax.set_axis_off()
    ax.grid(False)
    ax.set_xticks([])
    ax.set_yticks([])
    ax.set_zticks([])
    for pane in (ax.xaxis, ax.yaxis, ax.zaxis):
        pane.pane.set_visible(False)


def render(X, Y, Zup, colors, elev, azim, out_path):
    fig = plt.figure(figsize=(12, 9), dpi=120)
    ax = fig.add_subplot(111, projection="3d")
    ax.scatter(X, Y, Zup, c=colors, s=1.0, marker=".", linewidths=0)
    ax.view_init(elev=elev, azim=azim)
    try:
        ax.set_box_aspect((np.ptp(X), np.ptp(Y), np.ptp(Zup)))
    except Exception:
        pass
    strip_axes(ax)
    fig.subplots_adjust(left=0, right=1, top=1, bottom=0)
    fig.savefig(out_path, dpi=120, bbox_inches="tight", pad_inches=0, facecolor="black")
    plt.close(fig)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    depth = np.load(DEPTH_NPY)
    classid = np.load(CLASS_NPY)
    bgr = cv2.imread(FRAME_PNG, cv2.IMREAD_COLOR)
    if bgr is None:
        raise FileNotFoundError(f"could not read frame: {FRAME_PNG}")
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    if not (depth.shape[:2] == classid.shape[:2] == rgb.shape[:2]):
        raise ValueError(f"shape mismatch depth {depth.shape[:2]} class {classid.shape[:2]} rgb {rgb.shape[:2]}")

    d_norm = normalize(depth)
    s = STRIDE
    road_full = (classid == ROAD_CLASS)

    for name, zf, graze_elev in [("old", z_old, 6.0), ("new", z_new, 6.0)]:
        z = zf(d_norm)
        X, Y, Zup = back_project(z)
        Xs = X[::s, ::s].reshape(-1)
        Ys = Y[::s, ::s].reshape(-1)
        Zs = Zup[::s, ::s].reshape(-1)
        colors = rgb[::s, ::s].reshape(-1, 3).astype(np.float32) / 255.0
        road_s = road_full[::s, ::s].reshape(-1)

        road_pts = np.stack([Xs[road_s], Ys[road_s], Zs[road_s]], axis=1)
        rms, extent, norm_resid = fit_plane_residual(road_pts)
        print(f"[{name}] road pts={road_pts.shape[0]} plane_RMS={rms:.4f} extent={extent:.4f} normalized_resid={norm_resid:.5f}")

        # grazing side view: low camera looking across the ground; flat road -> thin sheet, bowl -> curved
        render(Xs, Ys, Zs, colors, elev=graze_elev, azim=-88, out_path=os.path.join(OUT_DIR, f"road_{name}_grazing.png"))
        # 3/4 perspective
        render(Xs, Ys, Zs, colors, elev=28, azim=-60, out_path=os.path.join(OUT_DIR, f"road_{name}_persp.png"))

    print("wrote:", ", ".join(sorted(os.listdir(OUT_DIR))))


if __name__ == "__main__":
    main()
