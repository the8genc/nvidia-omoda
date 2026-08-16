# Concern: FastAPI routes for the live websocket pipeline — health, the shared ws, and swapping the live source | Non-concern: CV processing (pipeline pkg) | IO: (mp4) -> per-frame JSON stream
import asyncio
import json
import struct
import uuid
from contextlib import aclosing, asynccontextmanager, suppress
from pathlib import Path

from fastapi import FastAPI, File, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from starlette.concurrency import run_in_threadpool

from d4rt_backend.live import LiveStreamSession, StreamParams
from pipeline import Pipeline, vlm
from pipeline.d4rt_service import D4rtService
from pipeline.live import LiveLoop

# static-world wire header, matching `_WORLD_HEADER` in d4rt_backend/api.py:
# grid_side u32, numPoints u32, radius f32, camera x/y/z 3xf32. The int16 xyz,
# the uint8 labels and the uint16 spread follow, in that order.
_WORLD_HEADER = struct.Struct("<IIf3f")

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
# owns the warm D4RT engine + per-clip static-world cache; sessions are per-socket
D4RT = D4rtService()


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
    D4RT.start()  # warm the 13GB engine off the event loop; sessions are per-socket
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


async def _d4rt_read_commands(ws: WebSocket, session: LiveStreamSession):
    # client commands on the same socket the frames go out on (re-level / unlevel).
    # ends quietly on disconnect — the send loop already reports why the stream stopped.
    while True:
        try:
            raw = await ws.receive_text()
        except (WebSocketDisconnect, RuntimeError):
            return
        try:
            command = json.loads(raw).get("type")
        except json.JSONDecodeError:
            continue
        if command == "calibrate":
            session.request_calibration()
        elif command == "clear-ground":
            session.clear_ground()


@app.websocket("/api/local/d4rt-stream")
async def d4rt_stream(ws: WebSocket):
    # a per-socket live reconstruction of the CURRENT live source: static world built once
    # (cached), every pair levelled against it, moving blobs tracked, 6-class semantic wire frame.
    # grid defaults to 96 for speed; ?grid= overrides. model runs only while this socket is open.
    await ws.accept()
    if D4RT.load_error:
        await ws.close(code=4500, reason=D4RT.load_error[:120])
        return
    if not D4RT.loaded:
        await ws.close(code=4503, reason="D4RT model is still warming up; try again shortly.")
        return

    clip = D4RT.clip_for(LIVE.current_source())
    try:
        params = StreamParams.parse(
            frames=int(ws.query_params.get("frames", 2)),
            stride=int(ws.query_params.get("stride", 1)),
            grid_side=int(ws.query_params.get("grid", D4RT.default_grid)),
            segment=ws.query_params.get("segment", "1") not in ("0", "false"),
            aspect=float(ws.query_params.get("aspect", 16 / 9)),
        )
    except ValueError as error:
        await ws.close(code=4400, reason=str(error))
        return

    # build (or restore) the clip's static world before the first pair, so surfaces
    # and blob tracking are live from frame one. Off the event loop — it holds the GPU.
    scene = await run_in_threadpool(D4RT.ensure_scene, clip)
    session = LiveStreamSession(D4RT.engine, clip.path, params, clip.crop, scene)
    reader = None
    try:
        reconstructor = await run_in_threadpool(session.build_reconstructor)
        await ws.send_json(session.hello(reconstructor))
        reader = asyncio.create_task(_d4rt_read_commands(ws, session))
        async with aclosing(session.frames(reconstructor)) as stream:
            async for payload in stream:
                if isinstance(payload, dict):
                    await ws.send_json(payload)
                else:
                    await ws.send_bytes(payload)
    except WebSocketDisconnect:
        pass
    except Exception as error:
        print("D4RT STREAM ERROR", type(error).__name__, error, flush=True)
        with suppress(RuntimeError):
            await ws.close(code=4500, reason=str(error)[:120])
    finally:
        session.stop()
        if reader is not None:
            reader.cancel()
            with suppress(asyncio.CancelledError):
                await reader


@app.get("/api/local/d4rt-world")
async def d4rt_world():
    # the current source's static world as one binary document: header + int16 xyz +
    # uint8 labels + uint16 spread. Fetched once by the viewer when a clip is chosen;
    # 404 until the stream socket has built it (it is built on first d4rt connect).
    clip_id = Path(str(LIVE.current_source())).stem
    scene = D4RT.scene(clip_id)
    world = getattr(scene, "world", None) if scene is not None else None
    if world is None:
        return JSONResponse({"error": f"no world for {clip_id} yet"}, status_code=404)
    header = _WORLD_HEADER.pack(
        int(world.grid_side),
        int(world.xyz.shape[0]),
        float(world.radius),
        float(world.camera[0]),
        float(world.camera[1]),
        float(world.camera[2]),
    )
    return Response(
        content=header + world.xyz.tobytes() + world.labels.tobytes() + world.spread.tobytes(),
        media_type="application/octet-stream",
        headers={"Cache-Control": "no-store"},
    )


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
    # a boolean follow-up (the banner's public-hazard question) is the break-glass signal: it unlocks
    # the raw feed on rgb-stream when True and re-locks to the obfuscated view when False.
    answer = result.get("followup", {}).get("answer")
    if followup_bool and isinstance(answer, bool):
        LIVE.set_hazard(answer)
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
