# depth_qa.py: understand-mode geometric QA of monocular depth vs segmentation + frame
import os
import sys
import numpy as np
from PIL import Image

# Cityscapes trainId -> (name, RGB) palette for colorized seg
CS = {
    0: ("road", (128, 64, 128)),
    1: ("sidewalk", (244, 35, 232)),
    2: ("building", (70, 70, 70)),
    3: ("wall", (102, 102, 156)),
    4: ("fence", (190, 153, 153)),
    5: ("pole", (153, 153, 153)),
    6: ("trafflight", (250, 170, 30)),
    7: ("traffsign", (220, 220, 0)),
    8: ("vegetation", (107, 142, 35)),
    9: ("terrain", (152, 251, 152)),
    10: ("sky", (70, 130, 180)),
    11: ("person", (220, 20, 60)),
    12: ("rider", (255, 0, 0)),
    13: ("car", (0, 0, 142)),
    14: ("truck", (0, 0, 70)),
    15: ("bus", (0, 60, 100)),
    16: ("train", (0, 80, 100)),
    17: ("motorcycle", (0, 0, 230)),
    18: ("bicycle", (119, 11, 32)),
}

# turbo-ish colormap without matplotlib dependency assumption; use matplotlib if present
def turbo_rgb(x):
    # x in [0,1] normalized; return uint8 HxWx3 via matplotlib turbo
    import matplotlib
    matplotlib.use("Agg")
    # matplotlib >=3.9 removed cm.get_cmap; use the colormaps registry
    m = matplotlib.colormaps["turbo"]
    out = (m(x)[..., :3] * 255).astype(np.uint8)
    return out


def colorize_seg(classid):
    # map trainId array to RGB palette
    h, w = classid.shape
    out = np.zeros((h, w, 3), dtype=np.uint8)
    for cid, (name, rgb) in CS.items():
        out[classid == cid] = rgb
    return out


def per_class_depth(depth, classid):
    # return dict cid -> (name, count, mean, median, std)
    rows = {}
    for cid in np.unique(classid):
        cid = int(cid)
        mask = classid == cid
        vals = depth[mask]
        name = CS.get(cid, (str(cid), None))[0]
        rows[cid] = (name, int(mask.sum()), float(vals.mean()), float(np.median(vals)), float(vals.std()))
    return rows


def road_plane_fit(depth, classid):
    # fit depth ~ a*row + b*col + c over road pixels (cid 0); return stats
    mask = classid == 0
    ys, xs = np.nonzero(mask)
    z = depth[mask].astype(np.float64)
    A = np.column_stack([ys.astype(np.float64), xs.astype(np.float64), np.ones(len(ys))])
    coef, _, _, _ = np.linalg.lstsq(A, z, rcond=None)
    a, b, c = coef
    pred = A @ coef
    resid = z - pred
    ss_res = float(np.sum(resid ** 2))
    ss_tot = float(np.sum((z - z.mean()) ** 2))
    r2 = 1.0 - ss_res / ss_tot if ss_tot > 0 else float("nan")
    resid_std = float(resid.std())
    # correlation of road depth with image row
    corr = float(np.corrcoef(ys.astype(np.float64), z)[0, 1])
    return dict(a=float(a), b=float(b), c=float(c), r2=float(r2), resid_std=resid_std,
                corr_row=corr, n=int(mask.sum()), z=z, ys=ys)


def fg_bg_sanity(depth, classid, road_stats):
    # bottom 20% vs top 20% of road rows; building vs road mean
    ys = road_stats["ys"]
    z = road_stats["z"]
    ymin, ymax = ys.min(), ys.max()
    span = ymax - ymin
    bot_thr = ymax - 0.2 * span
    top_thr = ymin + 0.2 * span
    bot = z[ys >= bot_thr]
    top = z[ys <= top_thr]
    road_mean = float(depth[classid == 0].mean())
    bmask = classid == 2
    bmean = float(depth[bmask].mean()) if bmask.any() else float("nan")
    return dict(bot_mean=float(bot.mean()), bot_n=int(len(bot)),
                top_mean=float(top.mean()), top_n=int(len(top)),
                road_mean=road_mean, building_mean=bmean, building_n=int(bmask.sum()))


def build_composite(frame, depth, classid, out_path):
    # [frame | depth turbo | seg colorized] side by side, no text
    dn = depth.copy().astype(np.float64)
    lo, hi = np.percentile(dn, 1), np.percentile(dn, 99)
    dn = np.clip((dn - lo) / (hi - lo + 1e-9), 0, 1)
    depth_rgb = turbo_rgb(dn)
    seg_rgb = colorize_seg(classid)
    comp = np.concatenate([frame[..., :3], depth_rgb, seg_rgb], axis=1)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    Image.fromarray(comp).save(out_path)


def run(frame_id):
    depth = np.load(f"/work/results/A2/shibuya_{frame_id}_depth.npy")
    classid = np.load(f"/work/results/A1/shibuya_{frame_id}_classid.npy")
    frame = np.array(Image.open(f"/work/frames/shibuya_{frame_id}.png"))

    print(f"===== FRAME {frame_id} =====")
    print(f"depth shape {depth.shape} range [{depth.min():.4f},{depth.max():.4f}] (LARGER=NEARER)")

    print("\n-- PER-CLASS DEPTH (disparity-like) --")
    print(f"{'cid':>3} {'name':>11} {'count':>9} {'mean':>8} {'median':>8} {'std':>8}")
    rows = per_class_depth(depth, classid)
    for cid in sorted(rows):
        name, cnt, mean, med, std = rows[cid]
        print(f"{cid:>3} {name:>11} {cnt:>9} {mean:>8.3f} {med:>8.3f} {std:>8.3f}")

    # ordering check: building (far) should have LOWER depth-value than road foreground
    if 2 in rows and 0 in rows:
        bmean = rows[2][2]
        rmean = rows[0][2]
        holds = bmean < rmean
        print(f"\nORDERING: building mean depth {bmean:.3f} vs road mean depth {rmean:.3f} -> "
              f"building < road (farther) = {holds}")

    print("\n-- ROAD PLANARITY FIT: depth ~ a*row + b*col + c --")
    rp = road_plane_fit(depth, classid)
    print(f"a(row)={rp['a']:.6f}  b(col)={rp['b']:.6f}  c={rp['c']:.4f}")
    print(f"R2={rp['r2']:.4f}  resid_std={rp['resid_std']:.4f}  n_road={rp['n']}")
    print(f"corr(depth, row)={rp['corr_row']:.4f}  (sign shows near->far direction w/ row)")

    print("\n-- FG/BG SANITY --")
    fb = fg_bg_sanity(depth, classid, rp)
    print(f"road bottom20% mean depth = {fb['bot_mean']:.3f} (n={fb['bot_n']})")
    print(f"road top20%    mean depth = {fb['top_mean']:.3f} (n={fb['top_n']})")
    print(f"gradient bottom-minus-top = {fb['bot_mean']-fb['top_mean']:.3f} "
          f"(positive = nearer at bottom, expected)")
    print(f"building mean depth = {fb['building_mean']:.3f} (n={fb['building_n']}) vs "
          f"road mean depth = {fb['road_mean']:.3f}")

    out_path = f"/work/results/QA/depth_check_{frame_id}.png"
    build_composite(frame, depth, classid, out_path)
    print(f"\nCOMPOSITE written: {out_path}")
    print()


if __name__ == "__main__":
    for fid in ["05", "08"]:
        run(fid)
