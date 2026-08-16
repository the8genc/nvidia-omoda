# Concern: FastAPI routes for the live websocket pipeline — health, the shared ws, and swapping the live source | Non-concern: CV processing (pipeline pkg) | IO: (mp4) -> per-frame JSON stream
import asyncio
import json
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from pipeline import Pipeline, vlm
from pipeline.d4rt_live import D4rtLoop
from pipeline.live import LiveLoop
from pipeline.obfuscator import ObfuscatorLoop

# curated demo clips; the cycle button steps through them (add more files here, no code change)
DEFAULTS_DIR = Path("/work/defaults")


def _default_videos() -> list[Path]:
    return sorted(DEFAULTS_DIR.glob("*.mp4"))


_default_index = 0
_defaults = _default_videos()
# the live loop starts on the first default and loops it until a cycle/upload switches the source
DEFAULT_SOURCE = _defaults[0] if _defaults else Path("/work/default.mp4")

print("building pipeline...", flush=True)
PIPELINE = Pipeline()
print(f"pipeline ready on {PIPELINE.device}", flush=True)

# uploaded live sources land here (uncached, always looped fresh); the shared loop broadcasts to every connected socket
LIVE_ROOT = Path("/work/webapp/backend/live")
LIVE_ROOT.mkdir(parents=True, exist_ok=True)
LIVE = LiveLoop(PIPELINE, DEFAULT_SOURCE)
D4RT = D4rtLoop(LIVE)
OBFUSCATOR = ObfuscatorLoop(LIVE)


class _Observability:
    # broadcasts every /describe result to all subscribers. Fire-and-forget per client (create_task on
    # the loop) so a slow observer drops its own frames rather than blocking the describe response.
    def __init__(self):
        self._clients = set()

    def add(self, ws):
        self._clients.add(ws)

    def remove(self, ws):
        self._clients.discard(ws)

    def publish(self, payload: dict):
        text = json.dumps(payload)
        for ws in list(self._clients):
            asyncio.create_task(self._send(ws, text))

    async def _send(self, ws, text):
        try:
            await ws.send_text(text)
        except Exception:
            self._clients.discard(ws)


OBS = _Observability()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # start the always-on worker once, at boot — it runs independent of any observer
    loop = asyncio.get_running_loop()
    LIVE.start(loop)
    D4RT.start(loop)  # its own worker; idles until a d4rt viewer subscribes
    OBFUSCATOR.start(loop)  # ditto; idles until a privacy viewer subscribes
    yield


app = FastAPI(lifespan=lifespan)
# allow the browser frontend (different origin/port) to call this API cross-origin
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


async def _serve(ws: WebSocket, stream: str):
    # subscribe the socket to one concern's stream; the always-on worker broadcasts fresh frames to it.
    # pure observer — we never expect client messages, receive only to detect disconnect.
    await ws.accept()
    LIVE.add_client(stream, ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        LIVE.remove_client(stream, ws)


@app.websocket("/api/local/detection-stream")
async def detection_stream(ws: WebSocket):
    # image-space detection labels + normalized boxes for the overlay
    await _serve(ws, "detection")


@app.websocket("/api/local/rgb-stream")
async def rgb_stream(ws: WebSocket):
    # most sensitive: the raw camera pixels
    await _serve(ws, "rgb")


@app.websocket("/api/local/d4rt-stream")
async def d4rt_stream(ws: WebSocket):
    # binary point-cloud frames (self-describing wire format); model runs only while subscribed
    await ws.accept()
    D4RT.add_client(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        D4RT.remove_client(ws)


@app.websocket("/api/local/obfuscated-stream")
async def obfuscated_stream(ws: WebSocket):
    # privacy view: each frame segmented and flattened to one colour per segment; runs only while subscribed
    await ws.accept()
    OBFUSCATOR.add_client(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        OBFUSCATOR.remove_client(ws)


@app.post("/api/live/source")
async def live_source(video: UploadFile = File(...)):
    # persist the uploaded mp4 and point the live loop at it; it starts looping THAT video uncached
    name = f"{uuid.uuid4().hex[:12]}.mp4"
    path = LIVE_ROOT / name
    data = await video.read()
    await run_in_threadpool(path.write_bytes, data)
    LIVE.set_source(path)
    LIVE.resume()  # stop -> upload -> auto-play the new source from scratch
    return JSONResponse({"source": name})


@app.post("/api/live/pause")
async def live_pause():
    LIVE.pause()
    return {"running": False}


@app.post("/api/live/resume")
async def live_resume():
    LIVE.resume()
    return {"running": True}


@app.post("/api/live/next-default")
async def live_next_default():
    # step to the next curated demo clip and play it from scratch
    global _default_index
    videos = _default_videos()
    if not videos:
        return JSONResponse({"error": "no default videos"}, status_code=404)
    _default_index = (_default_index + 1) % len(videos)
    src = videos[_default_index]
    LIVE.set_source(src)
    LIVE.resume()
    return {"index": _default_index, "name": src.name}


@app.get("/api/health")
async def health():
    return {"ok": True, "device": PIPELINE.device, "detector": PIPELINE.detector_id, "running": LIVE.is_running()}


def _describe_frame(frame, prompt, followup_q, followup_bool):
    # describe, then optionally ask a follow-up on the SAME conversation. The follow-up reuses the
    # image prefill (vLLM prefix cache) so it's cheap; both run in one call so there is no race.
    answer, messages = vlm.describe(frame, prompt)
    out = {"description": answer}
    if followup_q:
        f_answer, _ = vlm.followup(messages, followup_q, followup_bool)
        out["followup"] = {"question": followup_q, "answer": f_answer}
    return out


@app.get("/api/describe")
async def describe(prompt: str | None = None, followup: str | None = None, followup_bool: bool = False):
    # optional ?prompt= overrides the question; optional ?followup= asks a second question on the same
    # frame in the same call; ?followup_bool=true returns a real boolean for mechanical consumption.
    # every result (default, custom, follow-up) is also broadcast on /api/observability.
    frame = LIVE.latest_frame()
    if frame is None:
        return JSONResponse({"error": "no frame captured yet"}, status_code=503)
    result = await run_in_threadpool(_describe_frame, frame, prompt, followup, followup_bool)
    OBS.publish({"prompt": prompt, **result})
    return result


@app.websocket("/api/observability")
async def observability(ws: WebSocket):
    # subscribe to every describe result (default poll, custom prompt, follow-ups) as it is produced
    await ws.accept()
    OBS.add(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        OBS.remove(ws)
