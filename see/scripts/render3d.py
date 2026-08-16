# Concern: lift a labeled 2D frame + relative depth into a colored-by-label 3D point cloud and render two stripped views | Non-concern: metric accuracy, segmentation/depth estimation quality, camera calibration | IO: reads --seg colorized PNG + --depth npy, writes <out>/pcd_side.png and <out>/pcd_top.png
import argparse
import os
import numpy as np
import cv2
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d import Axes3D  # noqa: F401  registers the 3d projection


# ASSUMPTION: monocular depth carries no intrinsics, so we assume a 60 deg horizontal FOV and a centered principal point; the lift is structurally correct but metrically arbitrary, which is acceptable and stated here rather than hidden.
HORIZONTAL_FOV_DEG = 60.0
Z_NEAR = 1.0
Z_FAR = 10.0


def parse_args():
    p = argparse.ArgumentParser(description="Lift labeled 2D frame + depth into a colored 3D point cloud.")
    p.add_argument("--seg", required=True, help="colorized segmentation PNG (each pixel carries its class RGB)")
    p.add_argument("--depth", required=True, help="npy of per-pixel relative depth (disparity-like)")
    p.add_argument("--out", required=True, help="output directory for the two rendered PNGs")
    p.add_argument("--stride", type=int, default=4, help="pixel subsample step")
    return p.parse_args()


def normalize_depth_to_z(depth):
    # depth is Depth-Anything disparity-like (larger ~ nearer); map linearly so nearer pixels get smaller camera-space Z.
    d = depth.astype(np.float32)
    d_min, d_max = float(d.min()), float(d.max())
    span = max(d_max - d_min, 1e-6)
    nearness = (d - d_min) / span
    z = Z_FAR - nearness * (Z_FAR - Z_NEAR)
    return z


def back_project(z, width, height):
    fx = (width / 2.0) / np.tan(np.radians(HORIZONTAL_FOV_DEG) / 2.0)
    fy = fx
    cx, cy = width / 2.0, height / 2.0
    us, vs = np.meshgrid(np.arange(width), np.arange(height))
    x = (us - cx) * z / fx
    y = (vs - cy) * z / fy
    return x, y, z


def strip_axes(ax):
    ax.set_axis_off()
    ax.grid(False)
    ax.set_xticks([])
    ax.set_yticks([])
    ax.set_zticks([])
    for pane in (ax.xaxis, ax.yaxis, ax.zaxis):
        pane.pane.set_visible(False)


def render_view(x, y, z, colors, elev, azim, out_path):
    fig = plt.figure(figsize=(12, 9), dpi=120)
    ax = fig.add_subplot(111, projection="3d")
    # invert Y so image-down maps to visual-down; camera looks along +Z.
    ax.scatter(x, -y, z, c=colors, s=1.0, marker=".", linewidths=0)
    ax.view_init(elev=elev, azim=azim)
    strip_axes(ax)
    fig.subplots_adjust(left=0, right=1, top=1, bottom=0)
    fig.savefig(out_path, dpi=120, bbox_inches="tight", pad_inches=0, facecolor="black")
    plt.close(fig)


def main():
    args = parse_args()
    os.makedirs(args.out, exist_ok=True)

    seg_bgr = cv2.imread(args.seg, cv2.IMREAD_COLOR)
    if seg_bgr is None:
        raise FileNotFoundError(f"could not read seg image: {args.seg}")
    seg_rgb = cv2.cvtColor(seg_bgr, cv2.COLOR_BGR2RGB)
    depth = np.load(args.depth)

    if seg_rgb.shape[:2] != depth.shape[:2]:
        raise ValueError(f"seg {seg_rgb.shape[:2]} and depth {depth.shape[:2]} dimensions differ")

    height, width = depth.shape[:2]
    z = normalize_depth_to_z(depth)
    x, y, _ = back_project(z, width, height)

    s = args.stride
    xs = x[::s, ::s].reshape(-1)
    ys = y[::s, ::s].reshape(-1)
    zs = z[::s, ::s].reshape(-1)
    colors = (seg_rgb[::s, ::s].reshape(-1, 3).astype(np.float32) / 255.0)

    side_path = os.path.join(args.out, "pcd_side.png")
    top_path = os.path.join(args.out, "pcd_top.png")
    render_view(xs, ys, zs, colors, elev=15, azim=-70, out_path=side_path)
    render_view(xs, ys, zs, colors, elev=80, azim=-90, out_path=top_path)

    print(f"points rendered: {xs.size}")
    print(f"wrote {side_path}")
    print(f"wrote {top_path}")


if __name__ == "__main__":
    main()
