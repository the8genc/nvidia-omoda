# Concern: ask a VLM to describe one frame as structured JSON (object instances + attributes) | Non-concern: capturing frames (live loop), serving (app) | IO: (image data-uri) -> VLM response
import base64
import os

import cv2
import numpy as np
import requests

# OpenAI-compatible VLM endpoint. Defaults to the local Nemotron-Omni vLLM server already running on
# the box; point VLM_ENDPOINT/VLM_MODEL at a real VSS /summarize backend later without code changes.
VLM_ENDPOINT = os.environ.get("VLM_ENDPOINT", "http://localhost:8000/v1/chat/completions")
VLM_MODEL = os.environ.get("VLM_MODEL", "nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-NVFP4")
# downscale the frame before sending — fewer vision tokens => faster response, little detail lost for scene gist
VLM_MAX_WIDTH = int(os.environ.get("VLM_MAX_WIDTH", "512"))

_PROMPT = "Tersely describe the scene and any events of interest or hazards. Be brief — no filler."


def _downsample(image_data_uri: str, max_width: int) -> str:
    b64 = image_data_uri.split(",", 1)[1]
    bgr = cv2.imdecode(np.frombuffer(base64.b64decode(b64), np.uint8), cv2.IMREAD_COLOR)
    h, w = bgr.shape[:2]
    if w > max_width:
        scale = max_width / w
        bgr = cv2.resize(bgr, (max_width, int(h * scale)), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, 80])
    return "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode("ascii")


def describe_scene(image_data_uri: str, timeout: float = 180.0) -> dict:
    payload = {
        "model": VLM_MODEL,
        "messages": [
            # Nemotron directive: skip the verbose chain-of-thought and answer directly
            {"role": "system", "content": "detailed thinking off"},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": _PROMPT},
                    {"type": "image_url", "image_url": {"url": _downsample(image_data_uri, VLM_MAX_WIDTH)}},
                ],
            },
        ],
        "max_tokens": 256,
        "temperature": 0.2,
        # disable the model's chain-of-thought so the answer lands in content, not reasoning
        "chat_template_kwargs": {"enable_thinking": False},
    }
    resp = requests.post(VLM_ENDPOINT, json=payload, timeout=timeout)
    resp.raise_for_status()
    # return the raw VLM response verbatim — inspect it before committing to any field schema
    return resp.json()
