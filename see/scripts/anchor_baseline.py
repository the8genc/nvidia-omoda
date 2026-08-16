# Concern: characterize the RAW static-background depth hop between frames 05 and 08 (Stage B1a baseline) via shared-static difference stats + affine fit + residual + stripped diff viz | Non-concern: any fix, any pass/fail verdict, metric-scale calibration | IO: reads results/A2/shibuya_0{5,8}_depth.npy + results/A1/shibuya_0{5,8}_classid.npy, writes results/B1/diff_raw_05_08.png, prints stat block + plain-language reading
import os
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

A1_DIR = "/work/results/A1"
A2_DIR = "/work/results/A2"
OUT_DIR = "/work/results/B1"
os.makedirs(OUT_DIR, exist_ok=True)

# Cityscapes trainIds treated as static background
STATIC_TRAINIDS = {0, 1, 2, 3, 4, 8, 9}

depth_05 = np.load(os.path.join(A2_DIR, "shibuya_05_depth.npy")).astype(np.float64)
depth_08 = np.load(os.path.join(A2_DIR, "shibuya_08_depth.npy")).astype(np.float64)
classid_05 = np.load(os.path.join(A1_DIR, "shibuya_05_classid.npy"))
classid_08 = np.load(os.path.join(A1_DIR, "shibuya_08_classid.npy"))

# shared_static: pixels whose class id is static in BOTH frames
static_05 = np.isin(classid_05, list(STATIC_TRAINIDS))
static_08 = np.isin(classid_08, list(STATIC_TRAINIDS))
shared_static = static_05 & static_08

total_pixels = depth_05.size
n_shared = int(shared_static.sum())
pct_shared = 100.0 * n_shared / total_pixels

# per-pixel raw difference
diff = depth_08 - depth_05
diff_static = diff[shared_static]
diff_all = diff.reshape(-1)

# stats over shared_static and over ALL pixels
stat_static_mean = float(diff_static.mean())
stat_static_median = float(np.median(diff_static))
stat_static_std = float(diff_static.std())
stat_all_mean = float(diff_all.mean())
stat_all_median = float(np.median(diff_all))
stat_all_std = float(diff_all.std())

# best least-squares affine fit depth_08 ~ a*depth_05 + b over shared_static
x = depth_05[shared_static]
y = depth_08[shared_static]
A = np.vstack([x, np.ones_like(x)]).T
(a, b), _, _, _ = np.linalg.lstsq(A, y, rcond=None)
a = float(a)
b = float(b)

# residual std AFTER removing the affine (separates global scale/shift hop from real content change + noise)
residual = y - (a * x + b)
residual_std = float(residual.std())

# stripped visualization of the raw per-pixel depth difference
DIFF_PNG = os.path.join(OUT_DIR, "diff_raw_05_08.png")
H, W = diff.shape
vmax = float(np.percentile(np.abs(diff), 99))
fig = plt.figure(figsize=(W / 100.0, H / 100.0), dpi=100)
ax = plt.Axes(fig, [0.0, 0.0, 1.0, 1.0])
ax.set_axis_off()
fig.add_axes(ax)
ax.imshow(diff, cmap="turbo", vmin=-vmax, vmax=vmax, aspect="auto")
fig.savefig(DIFF_PNG, dpi=100)
plt.close(fig)

print("=== ANCHOR BASELINE (Stage B1a) : frames 05 vs 08, RAW depth ===")
print(f"total_pixels={total_pixels}")
print(f"shared_static_count={n_shared}")
print(f"shared_static_pct={pct_shared:.4f}%")
print("--- diff = depth_08 - depth_05 over SHARED_STATIC ---")
print(f"static_mean={stat_static_mean:.6f}")
print(f"static_median={stat_static_median:.6f}")
print(f"static_std={stat_static_std:.6f}")
print("--- diff over ALL pixels ---")
print(f"all_mean={stat_all_mean:.6f}")
print(f"all_median={stat_all_median:.6f}")
print(f"all_std={stat_all_std:.6f}")
print("--- affine fit depth_08 ~ a*depth_05 + b over SHARED_STATIC ---")
print(f"a={a:.6f}")
print(f"b={b:.6f}")
print(f"residual_std_after_affine={residual_std:.6f}")
print(f"wrote={DIFF_PNG}")

# plain-language reading: how much of the hop is global affine vs residual
frac_removed = 1.0 - (residual_std / stat_static_std) if stat_static_std > 0 else 0.0
print("--- READING ---")
print(
    "READING: Over the shared static background, the raw frame-to-frame depth difference has "
    f"mean {stat_static_mean:.4f} and std {stat_static_std:.4f} (disparity-like units). "
    f"A single global affine map depth_08 = {a:.4f}*depth_05 + {b:.4f} best relates the two frames; "
    f"applying it drops the spread from {stat_static_std:.4f} to a residual std of {residual_std:.4f}, "
    f"i.e. the affine removes about {100.0*frac_removed:.1f}% of the variance-spread of the hop. "
    "If that fraction is large and a is near 1 with small b, the hop is mostly a benign global scale/shift "
    "(the monocular model re-anchored its arbitrary depth range between frames, not a real geometry change). "
    "If the residual std stays comparable to the original std, the hop is dominated by genuine per-pixel "
    "content change and model noise rather than a single global re-anchoring."
)
