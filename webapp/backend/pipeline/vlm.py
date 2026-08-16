# Concern: VLM scene description + cheap follow-up questions on the same frame (conversation reuse) | Non-concern: capturing frames (live loop), serving (app) | IO: (image data-uri) -> answer + conversation
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


def _ask(messages: list, timeout: float, max_tokens: int) -> str:
    payload = {
        "model": VLM_MODEL,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": 0.2,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    resp = requests.post(VLM_ENDPOINT, json=payload, timeout=timeout)
    resp.raise_for_status()
    return (resp.json()["choices"][0]["message"]["content"] or "").strip()


def describe(image_data_uri: str, prompt: str | None = None, timeout: float = 180.0) -> tuple[str, list]:
    # first turn: pays the image prefill once. Returns the full conversation so follow-ups can reuse it.
    messages = [
        {"role": "system", "content": "detailed thinking off"},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": prompt or _PROMPT},
                {"type": "image_url", "image_url": {"url": _downsample(image_data_uri, VLM_MAX_WIDTH)}},
            ],
        },
    ]
    answer = _ask(messages, timeout, max_tokens=256)
    messages.append({"role": "assistant", "content": answer})
    return answer, messages


def followup(messages: list, question: str, as_bool: bool = False, timeout: float = 120.0) -> tuple:
    # reuses the prior conversation (system + image + Q1 + A1); vLLM prefix-caches the shared prefix so
    # the expensive image prefill is NOT recomputed — only the new question + short answer are generated
    ask = question + " Answer with only true or false." if as_bool else question
    convo = messages + [{"role": "user", "content": ask}]
    raw = _ask(convo, timeout, max_tokens=8 if as_bool else 256)
    convo.append({"role": "assistant", "content": raw})
    answer = "true" in raw.lower() if as_bool else raw
    return answer, convo
