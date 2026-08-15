# Concern: FastAPI routes for the live websocket pipeline — health, the shared ws, and swapping the live source | Non-concern: CV processing (pipeline pkg) | IO: (mp4) -> per-frame JSON stream
import asyncio
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from pipeline import Pipeline
from pipeline.live import LiveLoop
from pipeline.vlm import describe_scene

BACKEND_DIR = Path(__file__).resolve().parent
# the live loop starts here and loops forever until a client uploads a new source
DEFAULT_SOURCE = Path("/work/bellevue_15s.mp4")

print("building pipeline...", flush=True)
PIPELINE = Pipeline(BACKEND_DIR)
print(f"pipeline ready on {PIPELINE.device}", flush=True)

# uploaded live sources land here (uncached, always looped fresh); the shared loop broadcasts to every connected socket
LIVE_ROOT = Path("/work/webapp/backend/live")
LIVE_ROOT.mkdir(parents=True, exist_ok=True)
LIVE = LiveLoop(PIPELINE, DEFAULT_SOURCE)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # start the always-on worker once, at boot — it runs independent of any observer
    LIVE.start(asyncio.get_running_loop())
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


@app.websocket("/api/public/vocabulary-stream")
async def vocabulary_stream(ws: WebSocket):
    # privacy-preserved: the closed-vocabulary scene graph only, no pixels or positions
    await _serve(ws, "vocabulary")


@app.websocket("/api/local/detection-stream")
async def detection_stream(ws: WebSocket):
    # unrestricted: image-space detection labels + normalized boxes
    await _serve(ws, "detection")


@app.websocket("/api/local/rgb-stream")
async def rgb_stream(ws: WebSocket):
    # most sensitive: the raw camera pixels
    await _serve(ws, "rgb")


@app.post("/api/live/source")
async def live_source(video: UploadFile = File(...)):
    # persist the uploaded mp4 and point the live loop at it; it starts looping THAT video uncached
    name = f"{uuid.uuid4().hex[:12]}.mp4"
    path = LIVE_ROOT / name
    data = await video.read()
    await run_in_threadpool(path.write_bytes, data)
    LIVE.set_source(path)
    return JSONResponse({"source": name})


@app.get("/api/health")
def health():
    return {"ok": True, "device": PIPELINE.device, "detector": PIPELINE.detector_id}


@app.get("/api/describe")
async def describe():
    # on-demand VLM scene description of the latest frame — hit manually to see what the VLM returns
    frame = LIVE.latest_frame()
    if frame is None:
        return JSONResponse({"error": "no frame captured yet"}, status_code=503)
    result = await run_in_threadpool(describe_scene, frame)
    return JSONResponse(result)
