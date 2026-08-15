#!/bin/bash
# Start the SHARED Nemotron Omni vLLM. Anyone on the box may run this.
#
# Why this file exists: the model has to be reachable from three places, and a
# plain `-p 8000:8000` gets none of them right on this box.
#
#   1. the host itself            127.0.0.1:8000
#   2. the default docker bridge  172.17.0.1:8000   (ordinary containers)
#   3. the openshell bridge       172.18.0.1:8000   (NemoClaw sandboxes, which
#                                                    resolve host.openshell.internal
#                                                    to their own bridge gateway)
#
# We cannot publish on 0.0.0.0: that would also expose an unauthenticated
# inference API on whatever venue LAN the box is plugged into. Tailnet access is
# already handled separately by tailscale on 100.71.143.26:8000.
#
# So we publish on each bridge gateway explicitly, and DISCOVER those gateways at
# start time instead of hardcoding them. If a docker network is ever recreated
# with a different subnet, this still comes up; a hardcoded IP would not, and the
# container would sit in a restart loop with the shared model down for everyone.
#
# Memory: the original serve_omni.sh set no --gpu-memory-utilization, so vLLM
# took its default ~0.9 of unified memory. Weights are 21 GB; the rest was KV
# cache nobody asked for. See serve-nemotron-omni.sh for the capped flags.
set -euo pipefail

NAME=nemotron-omni
IMAGE=nvcr.io/nvidia/vllm@sha256:9204569b17ee4c0eff75194b8e6e458479c8aee18953b5ab9cf359fcdac659e2
HF_CACHE=/home/acer01/.cache/huggingface   # mounted READ-ONLY; never write here
LAUNCHER=/opt/spark/serve-nemotron-omni.sh

# Every docker bridge gateway, plus host loopback.
mapfile -t GATEWAYS < <(
  docker network ls --filter driver=bridge -q \
  | xargs -r docker network inspect -f '{{range .IPAM.Config}}{{.Gateway}}{{"\n"}}{{end}}' \
  | grep -E '^[0-9]+\.' | sort -u
)

PUBLISH=(-p 127.0.0.1:8000:8000)
for gw in "${GATEWAYS[@]}"; do
  PUBLISH+=(-p "${gw}:8000:8000")
done
echo "publishing on: 127.0.0.1 ${GATEWAYS[*]}"

docker rm -f "$NAME" >/dev/null 2>&1 || true
exec docker run -d --name "$NAME" \
  --restart unless-stopped \
  --gpus all \
  --add-host host.docker.internal:host-gateway \
  "${PUBLISH[@]}" \
  -v "$HF_CACHE:/root/.cache/huggingface:ro" \
  -v "$LAUNCHER:/serve_omni.sh:ro" \
  -e HF_HOME=/root/.cache/huggingface \
  -e HF_HUB_ENABLE_HF_TRANSFER=1 \
  --entrypoint /bin/bash \
  "$IMAGE" /serve_omni.sh
