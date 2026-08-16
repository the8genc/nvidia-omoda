# Concern: always-on live pipeline — an RGB thread that decodes/encodes frames at source fps (no GPU, runs free) and a separate detection thread that runs YOLOE as fast as it can and drops frames when the GPU is busy | Non-concern: HTTP (app) | IO: (mp4) -> per-frame JSON per stream
import asyncio
import base64
import json
import threading
import time

import cv2

# one websocket path per concern. Add a new concern here and emit its payload from the owning thread.
STREAMS = ("detection", "rgb")

_DEFAULT_FPS = 30.0


class LiveLoop:
    # RGB and detection run on separate threads so the video feed never waits on the GPU. The RGB
    # thread owns the capture, pacing and seq; the detection thread consumes the latest decoded frame
    # (drop-old) and overlays boxes by seq. Observers are pure: a slow one drops its own frames only.
    def __init__(self, pipeline, default_source):
        self._pipeline = pipeline
        self._source = default_source
        self._pending_source = None
        self._source_lock = threading.Lock()
        self._clients = {name: set() for name in STREAMS}
        self._busy = set()
        self._loop = None
        self._seq = 0
        self._last_rgb = None  # latest frame as a jpeg data-uri, for on-demand VLM describe_scene
        self._running = True
        self._latest_frame = None  # (raw_bgr, seq, index, n_frames) handed from RGB -> detection thread
        self._frame_lock = threading.Lock()

    def start(self, loop):
        # called once from app startup with the running event loop; spawns the two always-on workers
        self._loop = loop
        threading.Thread(target=self._rgb_run, daemon=True).start()
        threading.Thread(target=self._det_run, daemon=True).start()

    def add_client(self, stream, ws):
        self._clients[stream].add(ws)

    def remove_client(self, stream, ws):
        self._clients[stream].discard(ws)
        self._busy.discard(ws)

    def set_source(self, path):
        with self._source_lock:
            self._pending_source = path

    def latest_frame(self):
        return self._last_rgb

    def pause(self):
        self._running = False

    def resume(self):
        # RGB thread reopens the capture from frame 0 on the next turn — play restarts from scratch
        self._running = True

    def is_running(self):
        return self._running

    async def _broadcast(self, clients, text):
        dead = []
        for ws in list(clients):
            try:
                await ws.send_text(text)
            except Exception:
                dead.append(ws)
        for ws in dead:
            clients.discard(ws)

    def _dispatch(self, stream, text):
        # on the loop thread: one independent send per client, dropping for any client still busy so a
        # slow observer thins out on its own without stalling the worker or the others
        for ws in list(self._clients[stream]):
            if ws in self._busy:
                continue
            self._busy.add(ws)
            self._loop.create_task(self._send(stream, ws, text))

    async def _send(self, stream, ws, text):
        try:
            await ws.send_text(text)
        except Exception:
            self._clients[stream].discard(ws)
        finally:
            self._busy.discard(ws)

    def _emit(self, stream, text):
        # fire-and-forget onto the event loop; the worker never blocks on observer I/O
        self._loop.call_soon_threadsafe(self._dispatch, stream, text)

    def _take_pending(self):
        with self._source_lock:
            p = self._pending_source
            self._pending_source = None
            return p

    def _rgb_run(self):
        # owns the capture; decode + jpeg encode + broadcast rgb. No GPU work, so it holds source fps
        # regardless of what the detection thread or the VLM are doing on the GPU.
        cap = None
        i = 0
        n_frames = 0
        frame_dt = 1.0 / _DEFAULT_FPS
        while True:
            t0 = time.monotonic()
            if not self._running:
                if cap is not None:
                    cap.release()
                    cap = None
                time.sleep(0.1)
                continue
            pending = self._take_pending()
            if pending is not None:
                if cap is not None:
                    cap.release()
                cap = None
                self._source = pending
            if cap is None:
                cap = cv2.VideoCapture(str(self._source))
                if not cap.isOpened():
                    cap = None
                    time.sleep(0.5)
                    continue
                n_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
                fps = cap.get(cv2.CAP_PROP_FPS)
                frame_dt = 1.0 / fps if fps and fps > 0 else 1.0 / _DEFAULT_FPS
                i = 0
            ok, raw_bgr = cap.read()
            if not ok:
                cap.release()
                cap = None
                if i > 0:
                    n_frames = i
                continue
            self._seq += 1
            seq = self._seq
            # hand the freshest frame to the detection thread (drop-old — it only ever sees the newest)
            with self._frame_lock:
                self._latest_frame = (raw_bgr, seq, i, n_frames)
            ok, buf = cv2.imencode(".jpg", raw_bgr, [cv2.IMWRITE_JPEG_QUALITY, 80])
            if ok:
                rgb_uri = "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode("ascii")
                self._last_rgb = rgb_uri
                self._emit("rgb", json.dumps({"seq": seq, "index": i, "rgb": rgb_uri}))
            i += 1
            lag = frame_dt - (time.monotonic() - t0)
            if lag > 0:
                time.sleep(lag)

    def _det_run(self):
        # consumes the latest decoded frame and runs YOLOE (GPU). Naturally rate-adaptive: when the GPU
        # is busy (e.g. a VLM query) it simply processes fewer frames — the RGB feed is unaffected.
        last_seq = -1
        while True:
            if not self._clients["detection"]:
                # nobody is viewing boxes — don't run YOLOE at all, leave the GPU free for the VLM
                time.sleep(0.05)
                continue
            with self._frame_lock:
                item = self._latest_frame
            if item is None or item[1] == last_seq:
                time.sleep(0.005)
                continue
            raw_bgr, seq, i, n_frames = item
            last_seq = seq
            try:
                rgb = cv2.cvtColor(raw_bgr, cv2.COLOR_BGR2RGB)
                detections = self._pipeline.detect(rgb)
            except Exception as e:
                print("DETECTION ERROR", type(e).__name__, e, flush=True)
                continue
            h, w = raw_bgr.shape[:2]
            boxes = [
                {"label": d.label, "x1": d.x1 / w, "y1": d.y1 / h, "x2": d.x2 / w, "y2": d.y2 / h, "conf": d.conf}
                for d in detections
            ]
            self._emit("detection", json.dumps({"seq": seq, "index": i, "n_frames": n_frames, "boxes": boxes}))
