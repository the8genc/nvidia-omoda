# Concern: always-on live pipeline — an RGB thread that decodes/paces frames at source fps, and detection + privacy worker threads that each run the GPU on the freshest frame and are pushed work (never poll) | Non-concern: HTTP (app) | IO: (mp4) -> per-frame JSON per stream
import base64
import json
import threading
import time

import cv2

from .depth_privacy import DepthPrivacy
from .obfuscator import Obfuscator

# one websocket path per concern. Add a new concern here and emit its payload from the owning thread.
STREAMS = ("detection", "rgb")

_DEFAULT_FPS = 30.0


class LiveLoop:
    # RGB decodes + paces the raw feed (no GPU). Detection (YOLOE) and privacy (depth or SAM) each run
    # the GPU on their own thread, woken by a Condition when a fresh frame or a state change lands — an
    # idle worker blocks rather than spins, so a viewer who is not watching a stream costs nothing.
    def __init__(self, pipeline, default_source, depth_service=None):
        self._pipeline = pipeline
        self._source = default_source
        self._pending_source = None
        self._clients = {name: set() for name in STREAMS}
        self._busy = set()
        self._loop = None
        self._seq = 0
        self._last_rgb = None  # latest RAW frame as a jpeg data-uri, for the VLM only (it must see the real scene)
        self._running = True
        # the freshest decoded frame, handed to the worker threads. Guarded by _cv, which the producer
        # and every state change notify so a waiting worker re-evaluates without polling.
        self._latest_frame = None  # (raw_bgr, seq, index, n_frames)
        self._cv = threading.Condition()
        # interrupts the rgb thread's pace/backoff waits, so a source swap or resume takes effect at once
        self._wake = threading.Event()
        # the privacy firewall: the main feed is a privacy view by default; a hazard unlocks raw.
        self._hazard = False
        # which privacy view to serve: "sam" (FastSAM segmentation, the cheap default) or
        # "depth" (Open-d4rt depth map), turned on from the UI when wanted
        self._privacy_mode = "sam"
        self._obfuscator = Obfuscator()
        self._depth = DepthPrivacy(depth_service) if depth_service is not None else None

    def start(self, loop):
        # called once from app startup with the running event loop; spawns the always-on workers
        self._loop = loop
        threading.Thread(target=self._rgb_run, daemon=True).start()
        threading.Thread(target=self._det_run, daemon=True).start()
        threading.Thread(target=self._privacy_run, daemon=True).start()

    def add_client(self, stream, ws):
        with self._cv:
            self._clients[stream].add(ws)
            self._cv.notify_all()  # a worker blocked on "no clients" can now start

    def remove_client(self, stream, ws):
        with self._cv:
            self._clients[stream].discard(ws)
            self._busy.discard(ws)

    def set_source(self, path):
        with self._cv:
            self._pending_source = path
        self._wake.set()  # break the rgb pacing wait so the swap is immediate

    def latest_frame(self):
        return self._last_rgb

    def current_source(self):
        # the source currently playing (the D4RT worker feeds its own capture off this)
        return self._source

    def latest_bgr(self):
        # the most recent raw BGR frame (or None) — the obfuscator segments this
        with self._cv:
            item = self._latest_frame
        return item[0] if item else None

    def set_hazard(self, value):
        # break-glass: True unlocks the raw feed on rgb-stream; False re-locks it to the privacy view
        with self._cv:
            self._hazard = bool(value)
            self._cv.notify_all()  # wake the privacy worker to resume/pause

    def hazard(self):
        return self._hazard

    def reveal(self, seconds=10.0):
        # demo override: unlock the raw feed now and re-lock after `seconds`, scheduled on the event loop
        self.set_hazard(True)
        self._loop.call_later(seconds, lambda: self.set_hazard(False))

    def set_privacy_mode(self, mode):
        # "depth" -> Open-d4rt depth map; "sam" -> FastSAM segmentation. Toggled live, no restart.
        if mode not in ("depth", "sam"):
            raise ValueError(f"privacy mode must be 'depth' or 'sam', got {mode!r}")
        with self._cv:
            self._privacy_mode = mode

    def privacy_mode(self):
        return self._privacy_mode

    def pause(self):
        self._running = False
        self._wake.set()

    def resume(self):
        # RGB thread reopens the capture from frame 0 on the next turn — play restarts from scratch
        self._running = True
        self._wake.set()

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
        with self._cv:
            p = self._pending_source
            self._pending_source = None
            return p

    def _next_frame(self, stream, last_seq, wanted):
        # block until there is a fresh frame this worker wants, or a state change; return it and its seq.
        # `wanted()` re-reads the gating state (clients, hazard, mode) each wake, all under _cv.
        with self._cv:
            while not (wanted() and self._latest_frame is not None and self._latest_frame[1] != last_seq):
                self._cv.wait()
            return self._latest_frame

    def _rgb_run(self):
        # owns the capture; decode + jpeg encode + pace to source fps. No GPU work, so it holds fps
        # regardless of what the detection thread or the VLM are doing on the GPU.
        cap = None
        i = 0
        n_frames = 0
        frame_dt = 1.0 / _DEFAULT_FPS
        while True:
            t0 = time.monotonic()
            self._wake.clear()
            if not self._running:
                if cap is not None:
                    cap.release()
                    cap = None
                self._wake.wait(0.2)  # sleeps until resume()/set_source() wakes it
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
                    self._wake.wait(0.5)  # backoff before retrying the capture open
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
            ok, buf = cv2.imencode(".jpg", raw_bgr, [cv2.IMWRITE_JPEG_QUALITY, 80])
            if not ok:
                i += 1
                continue
            # the raw jpeg is kept ONLY for the VLM (it must see the real scene to judge hazard); it is
            # only put on the wire when a hazard has unlocked the feed.
            raw_uri = "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode("ascii")
            self._last_rgb = raw_uri
            # publish the freshest frame and wake the GPU workers (drop-old: they only ever see the newest)
            with self._cv:
                self._latest_frame = (raw_bgr, seq, i, n_frames)
                self._cv.notify_all()
            # hazard: the raw feed is unlocked, emit it here at source fps; the privacy view (locked) is
            # produced on the privacy thread so its GPU cost never throttles this decode loop.
            if self._clients["rgb"] and self._hazard:
                self._emit("rgb", json.dumps({"seq": seq, "index": i, "rgb": raw_uri, "unlocked": True}))
            i += 1
            lag = frame_dt - (time.monotonic() - t0)
            if lag > 0:
                self._wake.wait(lag)  # pace to source fps; interrupted by a source swap or pause

    def _privacy_run(self):
        # the locked main feed on its own thread: runs the privacy model (depth or SAM) back-to-back on
        # the freshest frame, blocked when nobody is watching or a hazard is serving raw. Fail CLOSED:
        # on error emit nothing rather than leak raw pixels.
        last_seq = -1
        wanted = lambda: bool(self._clients["rgb"]) and not self._hazard
        while True:
            raw_bgr, seq, i, _ = self._next_frame("rgb", last_seq, wanted)
            last_seq = seq
            privacy = self._privacy_view()
            try:
                view = privacy.obfuscate(raw_bgr)
                ok, buf = cv2.imencode(".jpg", view, [cv2.IMWRITE_JPEG_QUALITY, 80])
            except Exception as e:
                print("PRIVACY VIEW ERROR", type(e).__name__, e, flush=True)
                continue
            if ok:
                uri = "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode("ascii")
                self._emit("rgb", json.dumps({"seq": seq, "index": i, "rgb": uri, "unlocked": False}))

    def _privacy_view(self):
        # depth once its engine is warm; SAM when toggled, or as the warm-up fallback.
        if self._privacy_mode == "depth" and self._depth is not None and self._depth.ready:
            return self._depth
        return self._obfuscator

    def _det_run(self):
        # consumes the freshest frame and runs YOLOE (GPU), blocked when nobody is viewing boxes so the
        # GPU stays free for the VLM. Naturally rate-adaptive: a busy GPU simply yields fewer frames.
        last_seq = -1
        wanted = lambda: bool(self._clients["detection"])
        while True:
            raw_bgr, seq, i, n_frames = self._next_frame("detection", last_seq, wanted)
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
