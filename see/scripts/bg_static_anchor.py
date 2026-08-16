# Concern: TRUE static-background depth hop 05<->08 via a SEG-INDEPENDENT background-subtraction static mask (per-pixel temporal grayscale std over frames 04..08) + per-pixel temporal-median depth shimmer test (Stage B1b) | Non-concern: segmentation, metric-scale calibration, any pass/fail verdict | IO: reads frames/shibuya_04..08.png + results/A2/shibuya_04..08_depth.npy, writes results/B1/static_mask.png + results/B1/diff_static_only_05_08.png, prints stat block
import os
import numpy as np
import cv2
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

FRAMES_DIR = "/work/frames"
A2_DIR = "/work/results/A2"
OUT_DIR = "/work/results/B1"
os.makedirs(OUT_DIR, exist_ok=True)

# 5-frame temporal window; 05 and 08 are the anchor pair
WINDOW = ["04", "05", "06", "07", "08"]

# load the 5 RGB frames and their depth maps in matching order
grays = []
depths = []
for n in WINDOW:
    bgr = cv2.imread(os.path.join(FRAMES_DIR, f"shibuya_{n}.png"))
    if bgr is None:
        raise FileNotFoundError(f"Could not read frame shibuya_{n}.png")
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).astype(np.float64)
    grays.append(gray)
    d = np.load(os.path.join(A2_DIR, f"shibuya_{n}_depth.npy")).astype(np.float64)
    depths.append(d)

gray_stack = np.stack(grays, axis=0)
depth_stack = np.stack(depths, axis=0)
H, W = gray_stack.shape[1:]
total_pixels = H * W

# background subtraction: per-pixel temporal std of grayscale intensity across the window
temporal_std = gray_stack.std(axis=0)

# Otsu threshold on the temporal-std histogram (map float std to 0..255, threshold, map back)
std_min = float(temporal_std.min())
std_max = float(temporal_std.max())
std_u8 = np.clip((temporal_std - std_min) / (std_max - std_min + 1e-12) * 255.0, 0, 255).astype(np.uint8)
otsu_u8, _ = cv2.threshold(std_u8, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
otsu_thresh = std_min + (otsu_u8 / 255.0) * (std_max - std_min)

# chosen static rule: temporal std strictly below the Otsu knee
static_mask = temporal_std < otsu_thresh
mover_mask = ~static_mask
n_static = int(static_mask.sum())
n_mover = int(mover_mask.sum())
pct_static = 100.0 * n_static / total_pixels

# low-percentile cross-check thresholds on the same std map (report only)
p50 = float(np.percentile(temporal_std, 50))
p75 = float(np.percentile(temporal_std, 75))
pct_below_p50 = 100.0 * float((temporal_std < p50).mean())
pct_below_p75 = 100.0 * float((temporal_std < p75).mean())

# TRUE static hop: depth diff 05 -> 08 restricted to the background-subtraction static mask
depth_05 = depth_stack[WINDOW.index("05")]
depth_08 = depth_stack[WINDOW.index("08")]
diff = depth_08 - depth_05
diff_static = diff[static_mask]
diff_mover = diff[mover_mask]

hop_static_mean = float(diff_static.mean())
hop_static_median = float(np.median(diff_static))
hop_static_std = float(diff_static.std())
hop_mover_mean = float(diff_mover.mean())
hop_mover_median = float(np.median(diff_mover))
hop_mover_std = float(diff_mover.std())

# per-pixel temporal median depth across the window
temporal_median_depth = np.median(depth_stack, axis=0)
temporal_mean_depth = depth_stack.mean(axis=0)

# shimmer over STATIC pixels: residual of each frame's depth around the temporal reference, pooled over 5 frames
static_idx = static_mask
res_around_median = depth_stack - temporal_median_depth[None, :, :]
res_around_mean = depth_stack - temporal_mean_depth[None, :, :]
res_median_static = res_around_median[:, static_idx].reshape(-1)
res_mean_static = res_around_mean[:, static_idx].reshape(-1)

shimmer_raw_mean_ref = float(res_mean_static.std())
shimmer_median_ref = float(res_median_static.std())
shimmer_reduction_pct = 100.0 * (1.0 - shimmer_median_ref / shimmer_raw_mean_ref) if shimmer_raw_mean_ref > 0 else 0.0

# per-pixel temporal std of depth on static pixels: the raw frame-to-frame depth shimmer (no filter)
per_pixel_depth_std = depth_stack.std(axis=0)
raw_static_shimmer_mean = float(per_pixel_depth_std[static_idx].mean())
raw_static_shimmer_median = float(np.median(per_pixel_depth_std[static_idx]))

# viz 1: stripped static mask, white = static, black = mover
MASK_PNG = os.path.join(OUT_DIR, "static_mask.png")
mask_img = (static_mask.astype(np.uint8) * 255)
cv2.imwrite(MASK_PNG, mask_img)

# viz 2: stripped depth diff 05->08 with movers greyed out so static-only stability is visible
DIFF_PNG = os.path.join(OUT_DIR, "diff_static_only_05_08.png")
vmax = float(np.percentile(np.abs(diff_static), 99)) if n_static > 0 else float(np.percentile(np.abs(diff), 99))
vmax = vmax if vmax > 0 else float(np.percentile(np.abs(diff), 99) + 1e-6)
diff_masked = np.ma.array(diff, mask=mover_mask)
cmap = plt.get_cmap("turbo").copy()
cmap.set_bad(color="0.5")
fig = plt.figure(figsize=(W / 100.0, H / 100.0), dpi=100)
ax = plt.Axes(fig, [0.0, 0.0, 1.0, 1.0])
ax.set_axis_off()
fig.add_axes(ax)
ax.imshow(diff_masked, cmap=cmap, vmin=-vmax, vmax=vmax, aspect="auto")
fig.savefig(DIFF_PNG, dpi=100)
plt.close(fig)

# polluted baseline from Stage B1a (garbage-seg "static") for direct contrast
BASELINE_STD = 0.140

print("=== BG-SUBTRACTION STATIC ANCHOR (Stage B1b) : window shibuya_04..08 ===")
print(f"total_pixels={total_pixels}  (H={H}, W={W})")
print("--- static mask (SEG-INDEPENDENT: per-pixel temporal grayscale std) ---")
print(f"temporal_std_min={std_min:.6f}")
print(f"temporal_std_max={std_max:.6f}")
print(f"OTSU_THRESHOLD_grayvalue={otsu_thresh:.6f}")
print(f"static_rule=temporal_std < {otsu_thresh:.6f}")
print(f"static_count={n_static}")
print(f"static_pct={pct_static:.4f}%")
print(f"mover_count={n_mover}")
print(f"[xcheck] std_p50={p50:.6f} (pct_below={pct_below_p50:.2f}%)  std_p75={p75:.6f} (pct_below={pct_below_p75:.2f}%)")
print("--- TRUE static hop: diff = depth_08 - depth_05 over BG-SUB STATIC ---")
print(f"static_mean={hop_static_mean:.6f}")
print(f"static_median={hop_static_median:.6f}")
print(f"static_std={hop_static_std:.6f}")
print(f"polluted_baseline_std={BASELINE_STD:.3f}  (Stage B1a garbage-seg static)")
print("--- diff over MOVERS (contrast) ---")
print(f"mover_mean={hop_mover_mean:.6f}")
print(f"mover_median={hop_mover_median:.6f}")
print(f"mover_std={hop_mover_std:.6f}")
print("--- per-pixel temporal MEDIAN depth : static shimmer test ---")
print(f"raw_per_pixel_depth_std_over_static_MEAN={raw_static_shimmer_mean:.6f}")
print(f"raw_per_pixel_depth_std_over_static_MEDIAN={raw_static_shimmer_median:.6f}")
print(f"shimmer_residual_std_around_temporal_MEAN={shimmer_raw_mean_ref:.6f}")
print(f"shimmer_residual_std_around_temporal_MEDIAN={shimmer_median_ref:.6f}")
print(f"shimmer_reduction_median_vs_mean_pct={shimmer_reduction_pct:.4f}%")
print("--- artifacts ---")
print(f"wrote={MASK_PNG}")
print(f"wrote={DIFF_PNG}")
