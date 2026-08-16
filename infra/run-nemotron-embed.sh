#!/bin/bash
# NeMo Retriever embedding model for OMODA's retrieval store (PRD 23.2).
#
# nvidia/llama-nemotron-embed-1b-v2, served exactly as its model card instructs
# (vllm serve + --trust-remote-code). This is OMODA's own service, not the
# shared one: it binds loopback on 3140, inside our 3100-3199 block, and uses
# our own HF cache under /home/arif because the shared cache is read-only.
#
# Memory is capped hard. The model is 1.2B (about 2.5 GB bf16); 0.06 of unified
# memory is roomy for it and invisible next to the 121 GiB box.
set -euo pipefail

NAME=omoda-embed
IMAGE=nvcr.io/nvidia/vllm@sha256:9204569b17ee4c0eff75194b8e6e458479c8aee18953b5ab9cf359fcdac659e2
CACHE=/home/arif/hf-omoda

mkdir -p "$CACHE"
docker rm -f "$NAME" >/dev/null 2>&1 || true
exec docker run -d --name "$NAME" \
  --restart unless-stopped \
  --gpus all \
  -p 127.0.0.1:3140:3140 \
  -v "$CACHE:/root/.cache/huggingface" \
  -e HF_HOME=/root/.cache/huggingface \
  "$IMAGE" \
  vllm serve nvidia/llama-nemotron-embed-1b-v2 \
    --trust-remote-code \
    --host 0.0.0.0 --port 3140 \
    --gpu-memory-utilization 0.06
