# Concern: one always-on loop perceiving the live source forever at the source fps, fanning each frame out to per-concern streams (vocabulary, detection, rgb) with per-observer drop | Non-concern: HTTP (app) | IO: (mp4) -> per-frame JSON per stream
import asyncio
import base64
import json
import threading
import time

import cv2

# one websocket path per concern so each can be locked down independently later (need-to-know);
# served openly during dev. Add a new concern here and emit its payload in _process.
STREAMS = ("vocabulary", "detection", "rgb")

# fallback cadence when a source reports no fps; the worker paces itself to this like a real camera
_DEFAULT_FPS = 30.0


class LiveLoop:
    # a single always-on GPU worker loops the source forever, independent of who is watching.
    # observers are pure: connecting never changes the work done, and a slow observer only drops
    # its own frames (per-client), never throttling the worker or the other observers.
    def __init__(self, pipeline, default_source):
        self._pipeline = pipeline
        self._source = default_source
        self._pending_source = None
        self._source_lock = threading.Lock()
        self._clients = {name: set() for name in STREAMS}
        self._busy = set()  # sockets with an in-flight send; a new frame drops rather than queues
        self._loop = None
        self._thread = None
        self._seq = 0  # global monotonic frame id; never resets on loop or source switch (for rgb/box sync)
        self._last_rgb = None  # latest frame as a jpeg data-uri, for on-demand VLM describe_scene

    def start(self, loop):
        # called once from app startup with the running event loop; spawns the always-on worker
        self._loop = loop
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def add_client(self, stream, ws):
        # runs on the event loop thread (from the ws handler); precondition: stream in STREAMS
        self._clients[stream].add(ws)

    def remove_client(self, stream, ws):
        self._clients[stream].discard(ws)
        self._busy.discard(ws)

    def set_source(self, path):
        # worker picks this up at the next loop turn, releasing the current capture
        with self._source_lock:
            self._pending_source = path

    def latest_frame(self):
        # the most recent frame as a jpeg data-uri (or None before the first frame)
        return self._last_rgb

    def _emit(self, payloads):
        # hand the frame to the event loop and return immediately; the worker never blocks on I/O
        self._loop.call_soon_threadsafe(self._dispatch, payloads)

    def _dispatch(self, payloads):
        # on the loop thread: schedule one independent send per client, dropping for any client
        # still busy with its previous send so fast observers stay live and slow ones just skip frames
        for name, text in payloads.items():
            for ws in list(self._clients[name]):
                if ws in self._busy:
                    continue
                self._busy.add(ws)
                self._loop.create_task(self._send(name, ws, text))

    async def _send(self, name, ws, text):
        try:
            await ws.send_text(text)
        except Exception:
            self._clients[name].discard(ws)
        finally:
            self._busy.discard(ws)

    def _take_pending(self):
        with self._source_lock:
            p = self._pending_source
            self._pending_source = None
            return p

    def _run(self):
        cap = None
        i = 0
        n_frames = 0
        frame_dt = 1.0 / _DEFAULT_FPS
        while True:
            t0 = time.monotonic()
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
                # end of clip: seek back to frame 0 and keep looping forever
                cap.release()
                cap = None
                if i > 0:
                    n_frames = i
                continue
            try:
                payloads = self._process(i, n_frames, raw_bgr)
            except Exception as e:
                print("LIVE FRAME ERROR", type(e).__name__, e, flush=True)
                i += 1
                continue
            self._emit(payloads)
            i += 1
            # pace to the source fps so it behaves like a live camera; if perceive is slower than
            # real time this sleep is skipped and we simply run as fast as the GPU allows
            lag = frame_dt - (time.monotonic() - t0)
            if lag > 0:
                time.sleep(lag)

    def _process(self, i, n_frames, raw_bgr):
        self._seq += 1
        seq = self._seq
        rgb = cv2.cvtColor(raw_bgr, cv2.COLOR_BGR2RGB)
        detections = self._pipeline.detect(rgb)
        scene = self._pipeline.build_scene(i, detections)

        h, w = raw_bgr.shape[:2]
        boxes = [
            {"label": d.label, "x1": d.x1 / w, "y1": d.y1 / h, "x2": d.x2 / w, "y2": d.y2 / h, "conf": d.conf}
            for d in detections
        ]
        ok, buf = cv2.imencode(".jpg", raw_bgr, [cv2.IMWRITE_JPEG_QUALITY, 80])
        b64 = base64.b64encode(buf.tobytes()).decode("ascii") if ok else ""
        self._last_rgb = "data:image/jpeg;base64," + b64

        return {
            # privacy-preserved vocabulary: no pixels, no positions
            "vocabulary": json.dumps({"seq": seq, "index": i, "n_frames": n_frames, "scene": scene}),
            # unrestricted image-space detections (labels + normalized boxes)
            "detection": json.dumps({"seq": seq, "index": i, "n_frames": n_frames, "boxes": boxes}),
            # raw pixels — the most sensitive concern
            "rgb": json.dumps({"seq": seq, "index": i, "rgb": "data:image/jpeg;base64," + b64}),
        }
