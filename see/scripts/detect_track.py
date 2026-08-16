# Concern: YOLO11 segmentation + ByteTrack multi-object tracking over the ordered 10-frame Shibuya sequence restricted to traffic classes | Non-concern: pass/fail judgement, video muxing (done on host ffmpeg), model finetuning | IO: reads /work/frames/shibuya_01..10.png -> writes /work/results/B2/det_01..10.png + stdout per-frame class-count table + bus/car track-id persistence + crowd note

import os

# Pin all ultralytics/torch cache + config writes under /work so weights persist and no HOME write is attempted
os.environ["YOLO_CONFIG_DIR"] = "/tmp/Ultralytics"
os.environ["MPLCONFIGDIR"] = "/work/mpl_cfg"
os.environ["TORCH_HOME"] = "/work/torch_home"

import glob
import numpy as np
import cv2
import torch
from collections import defaultdict, OrderedDict
from ultralytics import YOLO

# Disable cuDNN: the seg mask-proto conv_transpose2d has no cuDNN engine on this GB10 build, native kernel works
torch.backends.cudnn.enabled = False

FRAMES_DIR = "/work/frames"
OUTPUT_DIR = "/work/results/B2"
MODELS_DIR = "/work/models"

# Traffic classes to keep (COCO ids) mapped to readable names for the count table
TRAFFIC_CLASSES = OrderedDict([(0, "person"), (1, "bicycle"), (2, "car"), (3, "motorcycle"), (5, "bus"), (7, "truck")])
CLASS_IDS = list(TRAFFIC_CLASSES.keys())

# Preferred segmentation weights with graceful fallbacks if a download is unavailable
MODEL_CANDIDATES = ["yolo11m-seg.pt", "yolo11n-seg.pt", "yolov8m-seg.pt"]


def load_model():
    # chdir into /work/models so any ultralytics auto-download lands there directly and persists across runs
    os.makedirs(MODELS_DIR, exist_ok=True)
    os.chdir(MODELS_DIR)
    last_err = None
    for name in MODEL_CANDIDATES:
        path = os.path.join(MODELS_DIR, name)
        try:
            src = path if os.path.exists(path) else name
            model = YOLO(src)
            print(f"[model] loaded {name} (cached at {path})")
            return model, name
        except Exception as e:
            last_err = e
            print(f"[model] {name} failed: {e}")
    raise RuntimeError(f"No segmentation model could be loaded: {last_err}")


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    os.makedirs(MODELS_DIR, exist_ok=True)

    frames = sorted(glob.glob(os.path.join(FRAMES_DIR, "shibuya_*.png")))
    if len(frames) == 0:
        raise FileNotFoundError(f"No frames found in {FRAMES_DIR}")
    print(f"[frames] {len(frames)} frames: {[os.path.basename(f) for f in frames]}")

    model, model_name = load_model()

    # Per-frame per-class counts and per-frame track ids collected for bus/car persistence analysis
    per_frame_counts = []
    per_frame_bus_ids = []
    per_frame_car_ids = []

    for idx, frame_path in enumerate(frames, start=1):
        img = cv2.imread(frame_path, cv2.IMREAD_COLOR)
        if img is None:
            raise FileNotFoundError(f"Could not read frame: {frame_path}")

        # Feed frames one at a time in order with persist=True so ByteTrack maintains identity across the sequence
        # imgsz=1280 matches native frame width so small distant pedestrians are not lost to the default 640 downscale
        results = model.track(source=img, persist=True, tracker="bytetrack.yaml", classes=CLASS_IDS, imgsz=1280, conf=0.25, verbose=False)
        result = results[0]

        counts = defaultdict(int)
        bus_ids = []
        car_ids = []
        if result.boxes is not None and result.boxes.cls is not None:
            cls_arr = result.boxes.cls.cpu().numpy().astype(int)
            ids_arr = result.boxes.id.cpu().numpy().astype(int) if result.boxes.id is not None else np.full(len(cls_arr), -1)
            for c, tid in zip(cls_arr, ids_arr):
                if c in TRAFFIC_CLASSES:
                    counts[c] += 1
                if c == 5:
                    bus_ids.append(int(tid))
                if c == 2:
                    car_ids.append(int(tid))

        per_frame_counts.append(counts)
        per_frame_bus_ids.append(sorted(bus_ids))
        per_frame_car_ids.append(sorted(car_ids))

        # Render boxes + class + track id + masks and save the annotated frame
        annotated = result.plot()
        out_path = os.path.join(OUTPUT_DIR, f"det_{idx:02d}.png")
        cv2.imwrite(out_path, annotated)
        print(f"[frame {idx:02d}] {os.path.basename(frame_path)} -> {out_path} counts={dict(counts)}")

    # Emit the per-frame class-count table
    print("\n===== PER-FRAME CLASS-COUNT TABLE =====")
    header = "frame  " + "  ".join(f"{n:>10}" for n in TRAFFIC_CLASSES.values()) + "     total"
    print(header)
    for i, counts in enumerate(per_frame_counts, start=1):
        row_total = sum(counts.values())
        cells = "  ".join(f"{counts.get(cid, 0):>10}" for cid in CLASS_IDS)
        print(f"{i:>5}  {cells}  {row_total:>8}")

    # Emit bus/car track-id persistence across consecutive frames
    print("\n===== BUS TRACK IDS PER FRAME =====")
    for i, ids in enumerate(per_frame_bus_ids, start=1):
        print(f"frame {i:02d}: {ids}")
    print("\n===== CAR TRACK IDS PER FRAME =====")
    for i, ids in enumerate(per_frame_car_ids, start=1):
        print(f"frame {i:02d}: {ids}")

    # Report consecutive-frame carryover for bus and car ids
    def carryover(seq, label):
        print(f"\n----- {label} consecutive-frame ID carryover -----")
        for i in range(1, len(seq)):
            prev = set(seq[i - 1])
            cur = set(seq[i])
            kept = sorted(prev & cur)
            new = sorted(cur - prev)
            lost = sorted(prev - cur)
            print(f"frame {i:02d}->{i+1:02d}: kept={kept} new={new} lost={lost}")

    carryover(per_frame_bus_ids, "BUS")
    carryover(per_frame_car_ids, "CAR")

    # Crowd note: report person counts and unique person track-id total to assess dense-crowd detection
    print("\n===== PEDESTRIAN CROWD DATA =====")
    person_counts = [c.get(0, 0) for c in per_frame_counts]
    print(f"person counts per frame: {person_counts}")
    print(f"person count min/max/mean: {min(person_counts)}/{max(person_counts)}/{sum(person_counts)/len(person_counts):.1f}")

    print(f"\n[done] model={model_name} frames={len(frames)} output={OUTPUT_DIR}")


if __name__ == "__main__":
    main()
