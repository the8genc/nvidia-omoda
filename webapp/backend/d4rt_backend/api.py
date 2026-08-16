"""HTTP surface: the clip playlist and the live reconstruction socket. Responsible for validation, status codes and wire framing. NOT concerned with inference, decoding or the library's contents."""

import asyncio
import json
import logging
import struct
from contextlib import aclosing, suppress
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect, status
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool

from .live import LiveStreamSession, StreamParams
from .services import Services

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api")

# grid side, point count, radius, and where the camera sits in the world's frame.
_WORLD_HEADER = struct.Struct("<IIf3f")


def get_services(request: Request) -> Services:
    return request.app.state.services


ServicesDep = Annotated[Services, Depends(get_services)]


@router.get("/health")
async def health(services: ServicesDep) -> dict[str, Any]:
    host = services.host
    return {
        "status": "error" if host.load_error else "ok",
        "modelLoaded": host.model_loaded,
        "engine": services.config.engine.kind,
        "clips": len(services.library.all()),
        "error": host.load_error,
    }


@router.get("/videos")
async def list_videos(services: ServicesDep) -> dict[str, Any]:
    """The whole playlist. The demo cycles through these; there is nothing to upload."""
    return {"videos": [clip.as_json() for clip in services.library.all()]}


@router.get("/videos/{clip_id}")
async def get_video(services: ServicesDep, clip_id: str) -> dict[str, Any]:
    clip = services.library.get(clip_id)
    if clip is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"No such clip: {clip_id}")
    return clip.as_json()


@router.get("/videos/{clip_id}/world")
async def get_world(services: ServicesDep, clip_id: str) -> Response:
    """The clip's static world: one header, then int16 xyz and a class per point.

    Fetched once when a clip is chosen, rather than pushed down the frame socket.
    It never changes for the life of the process, so it is a document, not an
    event — and keeping it off the socket leaves that channel carrying only what
    is actually live.
    """
    scene = services.scenes.get(clip_id)
    world = getattr(scene, "world", None) if scene is not None else None
    if world is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"No world for clip: {clip_id}")
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


async def _read_commands(websocket: WebSocket, session: LiveStreamSession) -> None:
    """Client commands on the same socket the frames go out on.

    Ends quietly on disconnect: the send loop reports why the stream stopped, and
    two reports of the same disconnect would be noise.
    """
    while True:
        try:
            raw = await websocket.receive_text()
        except (WebSocketDisconnect, RuntimeError):
            return
        try:
            command = json.loads(raw).get("type")
        except json.JSONDecodeError:
            logger.warning("Ignoring unreadable command: %s", raw[:80])
            continue
        if command == "calibrate":
            session.request_calibration()
        elif command == "clear-ground":
            session.clear_ground()
        else:
            logger.warning("Ignoring unknown command: %s", command)


@router.websocket("/videos/{clip_id}/live")
async def live_stream(websocket: WebSocket, clip_id: str) -> None:
    """Reconstruct a clip pair by pair, looping, for as long as the client listens.

    The clip is read forward through a small ring buffer and cropped per frame, so
    the model sees exactly what it would see off a camera: nothing is precomputed
    and no result is reused between pairs.
    """
    services: Services = websocket.app.state.services
    await websocket.accept()

    clip = services.library.get(clip_id)
    if clip is None:
        await websocket.close(code=4404, reason=f"No such clip {clip_id}")
        return

    host = services.host
    if host.load_error:
        await websocket.close(code=4500, reason=host.load_error[:120])
        return
    if not host.model_loaded:
        await websocket.close(code=4503, reason="Model is still warming up; try again shortly.")
        return

    try:
        params = StreamParams.parse(
            frames=int(websocket.query_params.get("frames", 2)),
            stride=int(websocket.query_params.get("stride", 1)),
            grid_side=int(websocket.query_params.get("grid", 160)),
            segment=websocket.query_params.get("segment", "1") not in ("0", "false"),
            aspect=float(websocket.query_params.get("aspect", 16 / 9)),
        )
    except ValueError as error:
        await websocket.close(code=4400, reason=str(error))
        return

    session = LiveStreamSession(
        host.engine, clip.path, params, clip.crop, services.scenes.get(clip_id)
    )
    reader: asyncio.Task | None = None
    try:
        reconstructor = await run_in_threadpool(session.build_reconstructor)
        await websocket.send_json(session.hello(reconstructor))
        # Commands arrive while frames are going out, so the read side needs its
        # own task; sharing the send loop would only see them between frames.
        reader = asyncio.create_task(_read_commands(websocket, session))
        async with aclosing(session.frames(reconstructor)) as stream:
            async for payload in stream:
                if isinstance(payload, dict):
                    await websocket.send_json(payload)
                else:
                    await websocket.send_bytes(payload)
    except WebSocketDisconnect:
        logger.info("Live stream for %s closed by client", clip_id)
    except Exception as error:
        logger.exception("Live stream for %s failed", clip_id)
        with suppress(RuntimeError):
            await websocket.close(code=4500, reason=str(error)[:120])
    finally:
        session.stop()
        if reader is not None:
            reader.cancel()
            with suppress(asyncio.CancelledError):
                await reader
