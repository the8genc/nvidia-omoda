#!/bin/bash
# Nemotron 3 Nano Omni (NVFP4) on vLLM, MEMORY CAPPED.
#
# The original serve_omni.sh set no --gpu-memory-utilization, so vLLM took its
# default of ~0.9 of unified memory. The weights are only 21 GB; the rest was KV
# cache preallocation nothing asked for. That is what starved the box.
#
# Changed from the original:
#   --gpu-memory-utilization 0.28   (was unset -> ~0.9)
#   --max-model-len 65536           (was 131072)
#   --max-num-seqs 8                (was 64)
# Everything else is byte-identical to what was running before.
set -e
pip install -q "vllm[audio]" 2>/dev/null || true
exec vllm serve nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-NVFP4 \
  --host 0.0.0.0 \
  --port 8000 \
  --gpu-memory-utilization 0.28 \
  --max-model-len 65536 \
  --max-num-seqs 8 \
  --tensor-parallel-size 1 \
  --trust-remote-code \
  --video-pruning-rate 0.5 \
  --allowed-local-media-path / \
  --media-io-kwargs "{\"video\": {\"fps\": 2, \"num_frames\": 256}}" \
  --reasoning-parser nemotron_v3 \
  --enable-auto-tool-choice \
  --tool-call-parser qwen3_coder \
  --kv-cache-dtype fp8
