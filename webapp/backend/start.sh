#!/bin/bash
# Concern: container entrypoint — installs web deps then execs uvicorn on 0.0.0.0:8091 | Non-concern: request handling and the models (app.py owns that) | IO: (container start) -> running server
set -e
pip install --no-cache-dir fastapi uvicorn python-multipart imageio lz4 >/tmp/pip_web.log 2>&1 || { echo PIP_FAIL; tail -20 /tmp/pip_web.log; exit 1; }
cd /work/webapp/backend
exec uvicorn app:app --host 0.0.0.0 --port 8091
