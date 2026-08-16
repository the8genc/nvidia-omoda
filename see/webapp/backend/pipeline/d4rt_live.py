# Concern: async D4RT worker — reconstruct the live source into point-cloud wire frames and broadcast to subscribers, model loaded lazily and only run while someone is viewing | Non-concern: HTTP (app), the model internals (realtime_d4rt), rgb/detection (live) | IO: (source path) -> binary point-cloud frames
import os
import sys
import threading
import time

# realtime_d4rt (the standalone reconstruction package) and the Open-d4rt model live outside the
# webapp; these are the DGX paths (the only place with the 13GB checkpoint). Override via env if moved.
RD4RT_PATH = os.environ.get("RD4RT_PATH", "/work/realtime_d4rt")
D4RT_REPO = os.environ.get("D4RT_REPO", "/work/Open-d4rt")
D4RT_CKPT = os.environ.get("D4RT_CKPT", "/work/models/d4rt/opend4rt.ckpt")
GRID_SIDE = int(os.environ.get("D4RT_GRID", "64"))
GAP = int(os.environ.get("D4RT_GAP", "8"))
EMA = float(os.environ.get("D4RT_EMA", "0.3"))


class D4rtLoop:
    # a lazy, subscriber-gated worker: loads the 13GB engine on first viewer, then reconstructs the
    # current live source into packed point-cloud frames and broadcasts them as binary. Restarts its
    # feeder when the live source switches. cuDNN is already disabled process-wide (perception.py) —
    # the GB10 sm_121 has no cuDNN engine for the model's conv3d, so native kernels are used.
    def __init__(self, live):
        self._live = live  # LiveLoop, for the current source path
        self._clients = set()
        self._busy = set()
        self._loop = None
        self._engine = None

    def start(self, loop):
        self._loop = loop
        threading.Thread(target=self._run, daemon=True).start()

    def add_client(self, ws):
        self._clients.add(ws)

    def remove_client(self, ws):
        self._clients.discard(ws)
        self._busy.discard(ws)

    def _emit(self, data: bytes):
        self._loop.call_soon_threadsafe(self._dispatch, data)

    def _dispatch(self, data: bytes):
        # one independent binary send per client, dropping for any client still busy (fresh-not-complete)
        for ws in list(self._clients):
            if ws in self._busy:
                continue
            self._busy.add(ws)
            self._loop.create_task(self._send(ws, data))

    async def _send(self, ws, data: bytes):
        try:
            await ws.send_bytes(data)
        except Exception:
            self._clients.discard(ws)
        finally:
            self._busy.discard(ws)

    def _load_engine(self):
        if RD4RT_PATH not in sys.path:
            sys.path.insert(0, RD4RT_PATH)
        # imported here, not at module top: the webapp must import cleanly on a box without the model
        from realtime_d4rt import Engine

        print("loading D4RT engine (13GB) ...", flush=True)
        engine = Engine(repo_path=D4RT_REPO, ckpt_path=D4RT_CKPT, grid_side=GRID_SIDE, device="cuda", use_bf16=True)
        engine.load()
        engine.warmup()
        print("D4RT engine ready", flush=True)
        return engine

    def _run(self):
        from realtime_d4rt import PairFeeder, TemporalStabiliser, pack_pair_frame

        while True:
            if not self._clients:
                # nobody is viewing the point cloud — don't run the model
                time.sleep(0.1)
                continue
            if self._engine is None:
                try:
                    self._engine = self._load_engine()
                except Exception as e:
                    print("D4RT ENGINE LOAD FAILED", type(e).__name__, e, flush=True)
                    time.sleep(2.0)
                    continue

            source = str(self._live.current_source())
            stabiliser = TemporalStabiliser(ema_alpha=EMA)
            index = 0
            try:
                pairs = iter(PairFeeder(source, gap=GAP))
                with self._engine.session():
                    # run until viewers leave or the live source switches, then rebuild the feeder
                    while self._clients and str(self._live.current_source()) == source:
                        frame_a, frame_b = next(pairs)
                        cloud = self._engine.reconstruct(frame_a, frame_b)
                        xyz = stabiliser.apply(cloud.xyz)
                        lock = stabiliser.lock
                        frame = pack_pair_frame(
                            index, cloud.gpu_seconds * 1000.0, lock.centre, lock.radius, xyz, cloud.rgb
                        )
                        self._emit(frame)
                        index += 1
            except StopIteration:
                pass
            except Exception as e:
                print("D4RT FRAME ERROR", type(e).__name__, e, flush=True)
                time.sleep(0.5)
