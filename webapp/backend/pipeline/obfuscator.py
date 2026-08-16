# Concern: async privacy-obfuscation worker — segment every frame (FastSAM) and flatten each segment to its mean colour, broadcast the obfuscated jpeg to subscribers, run only while viewed | Non-concern: HTTP (app), rgb/detection/d4rt (their workers), labels (obfuscation is class-agnostic) | IO: (latest frame) -> obfuscated jpeg frames
import base64
import json
import os
import threading
import time

import cv2
import numpy as np

FASTSAM_MODEL = os.environ.get("FASTSAM_MODEL", "FastSAM-s.pt")  # cached in the backend dir on the mount
IMGSZ = int(os.environ.get("FASTSAM_IMGSZ", "640"))


class ObfuscatorLoop:
    # a lazy, subscriber-gated worker: loads FastSAM on first viewer, then turns each live frame into a
    # privacy view — every segment filled with one colour (its mean), so shapes/layout survive but
    # faces/plates/fine detail do not. Broadcasts the obfuscated jpeg as a {seq, rgb} data-uri.
    def __init__(self, live):
        self._live = live
        self._clients = set()
        self._busy = set()
        self._loop = None
        self._model = None
        self._seq = 0

    def start(self, loop):
        self._loop = loop
        threading.Thread(target=self._run, daemon=True).start()

    def add_client(self, ws):
        self._clients.add(ws)

    def remove_client(self, ws):
        self._clients.discard(ws)
        self._busy.discard(ws)

    def _emit(self, text: str):
        self._loop.call_soon_threadsafe(self._dispatch, text)

    def _dispatch(self, text: str):
        for ws in list(self._clients):
            if ws in self._busy:
                continue
            self._busy.add(ws)
            self._loop.create_task(self._send(ws, text))

    async def _send(self, ws, text: str):
        try:
            await ws.send_text(text)
        except Exception:
            self._clients.discard(ws)
        finally:
            self._busy.discard(ws)

    def _load_model(self):
        # cuDNN is already disabled process-wide (perception.py); FastSAM's seg head would otherwise hit
        # the same GB10 sm_121 conv_transpose gap.
        from ultralytics import FastSAM

        print("loading FastSAM ...", flush=True)
        model = FastSAM(FASTSAM_MODEL)
        model.to("cuda")
        print("FastSAM ready", flush=True)
        return model

    def _obfuscate(self, bgr: np.ndarray) -> np.ndarray:
        h, w = bgr.shape[:2]
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        res = self._model.predict(rgb, imgsz=IMGSZ, verbose=False, device="cuda")[0]
        out = np.zeros_like(bgr)
        if res.masks is None:
            return out
        masks = res.masks.data.cpu().numpy() > 0.5  # [N, mh, mw]
        areas = masks.reshape(masks.shape[0], -1).sum(axis=1)
        # largest segments first so small items land on top rather than being buried
        for i in np.argsort(-areas):
            mk = cv2.resize(masks[i].astype(np.uint8), (w, h), interpolation=cv2.INTER_NEAREST).astype(bool)
            if not mk.any():
                continue
            out[mk] = bgr[mk].mean(axis=0)
        return out

    def _run(self):
        while True:
            if not self._clients:
                time.sleep(0.1)
                continue
            if self._model is None:
                try:
                    self._model = self._load_model()
                except Exception as e:
                    print("FASTSAM LOAD FAILED", type(e).__name__, e, flush=True)
                    time.sleep(2.0)
                    continue
            bgr = self._live.latest_bgr()
            if bgr is None:
                time.sleep(0.05)
                continue
            try:
                obf = self._obfuscate(bgr)
            except Exception as e:
                print("OBFUSCATE ERROR", type(e).__name__, e, flush=True)
                time.sleep(0.2)
                continue
            ok, buf = cv2.imencode(".jpg", obf, [cv2.IMWRITE_JPEG_QUALITY, 80])
            if not ok:
                continue
            self._seq += 1
            uri = "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode("ascii")
            self._emit(json.dumps({"seq": self._seq, "index": self._seq, "rgb": uri}))
