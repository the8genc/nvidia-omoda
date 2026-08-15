# Shared infrastructure on the GN100

The Acer Veriton GN100 is shared with the See team. Two rules matter more than
anything else in this file:

- **Bind only inside 3100-3199.** That is our port block. `src/domain/prohibited.js`
  enforces it for anything OMODA starts; the exceptions below are processes
  NemoClaw starts on its own, and they are tracked as a known gap.
- **Access the box as `arif` (`ssh gn100`).** The `acer01` login and everything
  under `/home/acer01` belong to the shared account, not to us. The HuggingFace
  cache there is mounted **read-only** on purpose.

## The shared vLLM

One Nemotron instance serves everybody. It is not owned by a user; it lives in
`/opt/spark` as root-owned, world-readable scripts so anyone on the box can
restart it.

| | |
|---|---|
| model | `nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-NVFP4` |
| container | `nemotron-omni`, `--restart unless-stopped` |
| start | `sudo /opt/spark/run-nemotron-omni.sh` |
| flags | `/opt/spark/serve-nemotron-omni.sh` |
| health | `curl http://100.71.143.26:8000/health` |

Mirrored in this repo under `infra/` so the settings survive the box.

### Memory cap

The original `serve_omni.sh` set no `--gpu-memory-utilization`, so vLLM took its
default of ~0.9 of unified memory and starved the box; that is what killed it
the first time. The weights are only 21 GB. The rest was KV cache nobody asked
for.

```
--gpu-memory-utilization 0.28
--max-model-len 65536
--max-num-seqs 8
```

Result: **43 GB used, 78 GB free**, against 115 GB before the cap.

### Why the context is 65536 and must not be lowered

It was 16384 for one afternoon, which broke the NemoClaw sandbox build at step
78 of 90:

```
Error: Hermes NEMOCLAW_CONTEXT_WINDOW must be at least 64000 tokens, got 16384
```

NemoClaw reads the served model's `max_model_len`, bakes it into the sandbox
image, and Hermes hard-requires at least 64000. The number cannot be faked in
the build; declaring 64k while vLLM serves 16k just moves the failure to
inference time.

It is not an arbitrary floor either. Hermes's own system prompt measures **16,138
tokens**, which would have consumed the entire 16,384 window before the user said
anything.

Raising it was free. The KV pool is sized by `--gpu-memory-utilization`, not by
`--max-model-len`, so the cap held:

| | pool | concurrency at that context |
|---|---|---|
| 16384 | 1,566,037 tokens | 95.6x |
| 65536 | 2,222,606 tokens | 33.9x |

Both are far above `--max-num-seqs 8`, so nothing queues.

### Why publishing needs every bridge gateway

`-p 8000:8000` is wrong on this box, and so is any single hardcoded address. The
model has to answer on three paths:

| caller | address |
|---|---|
| the host | `127.0.0.1:8000` |
| ordinary containers | `172.17.0.1:8000` (default bridge) |
| NemoClaw sandboxes | `172.18.0.1:8000` (`openshell-docker` bridge) |

A NemoClaw sandbox resolves `host.openshell.internal` to **its own** bridge
gateway, not to the default one. Publishing only on `172.17.0.1` leaves the
sandbox unable to reach the model, and Hermes reports it as
`HTTP 503: inference service unavailable`, which points nowhere near the real
cause.

We do not publish on `0.0.0.0`: that would expose an unauthenticated inference
API on whatever venue LAN the box is plugged into. Tailnet access is handled
separately by tailscale on `100.71.143.26:8000`.

`run-nemotron-omni.sh` therefore **discovers** bridge gateways at start time
rather than hardcoding them. A hardcoded IP would fail to bind if a docker
network were ever recreated on a different subnet, and `--restart unless-stopped`
would leave the shared model down for everyone in a restart loop.

Check every path at once:

```bash
for t in 127.0.0.1 100.71.143.26 172.17.0.1 172.18.0.1; do
  printf "%-16s " "$t"; curl -s -m 5 -o /dev/null -w "%{http_code}\n" "http://$t:8000/health"
done
```

## Things that will bite you

- **Do not kill PID 2344 (`tailscaled`).** It holds `:8080` and
  `100.71.143.26:8000`, and NemoClaw will cheerfully suggest killing it. It is
  the tailnet the whole box runs on.
- **`npm i -g nemoclaw` is not NVIDIA's package.** That name on npm is a
  different publisher's v0.1.0, no repository, no homepage. NVIDIA's is a source
  install from `github.com/NVIDIA/NemoClaw`, checked out at
  `~/.nemoclaw/source`; drive it with
  `node ~/.nemoclaw/source/bin/nemoclaw.js`.
- **The sandbox registry is per-gateway.** `nemoclaw list` reports "No sandboxes
  registered" unless you scope it, because ours lives under
  `~/.nemoclaw/gateways/3131/`. Always prefix `NEMOCLAW_GATEWAY_PORT=3131`;
  without it the CLI probes the default 8080, which is tailscaled.
- **A slow build is not a stalled build.** Sandbox creation legitimately runs
  ~20 minutes on first run, 90 Dockerfile steps plus a 3.92 GB base image. Read
  the log before concluding it hung.

## Our sandbox

```
omoda *
  agent: hermes   model: nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-NVFP4
  provider: vllm-local   sandbox GPU
  policies: npm, pypi, huggingface, brew, local-inference
```

Created against gateway 3131. The compiled OpenShell policy grants egress to
`host.openshell.internal:8000` as `protocol: rest, enforcement: enforce` with
explicit method rules, which is exactly the L7-filtered shape the PRD argues for.

```bash
export N="NEMOCLAW_GATEWAY_PORT=3131 node /home/arif/.nemoclaw/source/bin/nemoclaw.js"
eval $N list
eval $N omoda status
```

### Known gap: ports outside our block

The sandbox opens `8642` (Hermes OpenAI-compatible API), `18789` and `18790`
(dashboard). All three are outside 3100-3199. They bind loopback only, so they
cannot collide across the tailnet, but they can still collide with another
team's process on this host. `nemoclaw onboard --control-ui-port` can move at
least the control UI into our block. Tracked, not yet fixed.
