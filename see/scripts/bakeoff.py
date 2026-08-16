"""Semantic-segmentation bakeoff on Shibuya crossing frames.
Runs one model (given by --model short name) on shibuya_05 and shibuya_08,
saves colorized seg + overlay, prints per-class pixel distribution.
Unified post_process_semantic_segmentation path across SegFormer/Mask2Former/OneFormer.
"""
import os, sys, argparse, json
import numpy as np
import cv2
import torch

OUT = "/work/results/segbakeoff"
os.makedirs(OUT, exist_ok=True)

MODELS = {
    "segb5_city":   dict(id="nvidia/segformer-b5-finetuned-cityscapes-1024-1024", fam="segformer"),
    "segb4_ade":    dict(id="nvidia/segformer-b4-finetuned-ade-512-512",          fam="segformer"),
    "m2f_city":     dict(id="facebook/mask2former-swin-large-cityscapes-semantic", fam="mask2former"),
    "m2f_ade":      dict(id="facebook/mask2former-swin-large-ade-semantic",        fam="mask2former"),
    "oneformer_ade":  dict(id="shi-labs/oneformer_ade20k_swin_large",       fam="oneformer"),
    "oneformer_city": dict(id="shi-labs/oneformer_cityscapes_swin_large",   fam="oneformer"),
}

# Curated colors (RGB) for recognizable semantic names -> consistent visuals across models.
def color_for(name):
    n = name.lower()
    def has(*ks): return any(k in n for k in ks)
    if has("person","pedestrian","people"):            return (220, 20, 60)   # crimson
    if has("rider","cyclist"):                          return (255, 0, 0)     # red
    if has("bicycle","bike"):                           return (119, 11, 32)
    if has("motorcycle"):                               return (0, 0, 230)
    if has("bus"):                                      return (0, 60, 100)
    if has("truck","van"):                              return (0, 0, 70)
    if has("car","vehicle","auto"):                     return (0, 0, 200)    # blue
    if has("road","route","street"):                    return (128, 64, 128) # purple
    if has("sidewalk","pavement","path"):               return (244, 35, 232) # magenta
    if has("crosswalk","zebra"):                        return (255, 150, 0)  # orange
    if has("building","house","edifice","skyscraper","wall","tower"): return (70, 70, 70)
    if has("vegetation","tree","plant","grass","palm","bush"):        return (107, 142, 35)  # olive
    if has("terrain","earth","ground","field"):         return (152, 251, 152)
    if has("sky"):                                      return (135, 206, 235)  # sky blue
    if has("pole","signboard","sign","traffic light","streetlight","light"): return (250, 170, 30)
    if has("fence","railing","guard"):                  return (190, 153, 153)
    if has("water","sea","river"):                      return (0, 130, 200)
    return None

def build_palette(id2label):
    maxid = max(id2label.keys())
    pal = np.zeros((maxid + 1, 3), dtype=np.uint8)
    rng = np.random.RandomState(42)
    for i in range(maxid + 1):
        name = id2label.get(i, str(i))
        c = color_for(name)
        pal[i] = c if c is not None else rng.randint(40, 220, size=3)
    return pal

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, choices=list(MODELS))
    ap.add_argument("--frames", nargs="+", default=["05", "08"])
    args = ap.parse_args()
    spec = MODELS[args.model]
    mid, fam = spec["id"], spec["fam"]
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"=== {args.model}  ({mid})  fam={fam} device={device} ===", flush=True)

    if fam == "oneformer":
        from transformers import OneFormerProcessor
        proc = OneFormerProcessor.from_pretrained(mid)
    else:
        from transformers import AutoImageProcessor
        proc = AutoImageProcessor.from_pretrained(mid)

    if fam == "segformer":
        from transformers import SegformerForSemanticSegmentation as MC
        model = MC.from_pretrained(mid)
    elif fam == "mask2former":
        from transformers import Mask2FormerForUniversalSegmentation as MC
        model = MC.from_pretrained(mid)
    elif fam == "oneformer":
        from transformers import OneFormerForUniversalSegmentation as MC
        model = MC.from_pretrained(mid)
    model = model.to(device).eval()

    id2label = {int(k): v for k, v in model.config.id2label.items()}
    palette = build_palette(id2label)
    print(f"num classes: {len(id2label)}", flush=True)

    for f in args.frames:
        path = f"/work/frames/shibuya_{f}.png"
        bgr = cv2.imread(path, cv2.IMREAD_COLOR)
        H, W = bgr.shape[:2]
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)

        if fam == "segformer":
            # feed native aspect, no square-resize
            inputs = proc(images=rgb, do_resize=False, return_tensors="pt").to(device)
        elif fam == "oneformer":
            inputs = proc(images=rgb, task_inputs=["semantic"], return_tensors="pt").to(device)
        else:
            inputs = proc(images=rgb, return_tensors="pt").to(device)

        with torch.no_grad():
            outputs = model(**inputs)

        seg = proc.post_process_semantic_segmentation(outputs, target_sizes=[(H, W)])[0]
        seg = seg.cpu().numpy().astype(np.int32)

        seg_rgb = palette[seg]
        seg_bgr = cv2.cvtColor(seg_rgb, cv2.COLOR_RGB2BGR)
        overlay = cv2.addWeighted(bgr, 0.5, seg_bgr, 0.5, 0.0)
        cv2.imwrite(f"{OUT}/{args.model}_seg_{f}.png", seg_bgr)
        cv2.imwrite(f"{OUT}/{args.model}_overlay_{f}.png", overlay)

        total = seg.size
        ids, counts = np.unique(seg, return_counts=True)
        rows = sorted(((id2label.get(int(i), str(i)), 100.0 * c / total) for i, c in zip(ids, counts)),
                      key=lambda r: r[1], reverse=True)
        print(f"\n--- shibuya_{f} ({W}x{H}) per-class % ---", flush=True)
        for name, pct in rows:
            if pct >= 0.01:
                print(f"  {name:22s} {pct:7.3f}%", flush=True)
        # machine-readable line
        print("JSON " + json.dumps({"model": args.model, "frame": f,
              "dist": {name: round(pct, 3) for name, pct in rows if pct >= 0.01}}), flush=True)

    print(f"=== DONE {args.model} ===", flush=True)

if __name__ == "__main__":
    main()
