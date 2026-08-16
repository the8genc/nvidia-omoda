# The output streams: what the demo app consumes

OMODA is the hub. It consumes COCO's live interface (frames, descriptions, the
describe API) and republishes everything the demo needs on three WebSocket
endpoints, plus the one thing only OMODA can provide: realtime agent activity.

## Endpoints

All on the stream server (`ws://100.71.143.26:3111` on the box). **No auth
required on the output endpoints**: every consumer runs on the same hardware
(decision 2026-08-16), the topics are read-only, and secrets are stripped before
publish. Just connect. The ingest door (`/v1/stream`) still requires its token:
watching is free, proposing work is not. A viewer token still prints at boot in
case the outputs are ever locked again (`outputs.open` in boot).

| Endpoint | One message per | Shape |
|---|---|---|
| `/v1/out/frames` | video frame | `{topic:"frame", at, seq, index, rgb}` where `rgb` is the JPEG data URI relayed verbatim from COCO |
| `/v1/out/observations` | COCO description | `{topic:"observation", at, source, description, prompt, followup, danger_signal, verdict, intentId?, incidentType?, severity?, signals?}` |
| `/v1/out/agents` | agent action | `{topic:"agent", at, agentRoutedTo, incident, action, trigger, intentId}` — one event per trigger-driven routing (see below) |
| `/v1/out/agentic` | agentic event | `{topic:"agentic", at, event, correlationId, actor, target?, intentId?, detail}` — the fine-grained narration stream, catalog below |
| `/v1/out/audit` | audit record | the agentic audit trail, eight fields per engagement; see `docs/audit-stream.md` |

## What the observation verdicts mean

- `nominal`: quiet footage; no signals fired, no model consulted.
- `judged-nominal`: signals fired, Nemotron judged it not an incident.
- `incident`: an intent was opened; `intentId`, `incidentType`, `severity` present.
- `attached`: another observation of an already-open incident (`occurrences`).
- `candidate-skipped-busy`: a candidate arrived while a judgment was in flight;
  recorded and skipped so OMODA never queues behind COCO's captioning.

## The agent-action stream (`/v1/out/agents`)

One event per **trigger-driven routing**: when OMODA (L0) matches a take-action
trigger and routes an incident to an L1 agent, it emits exactly what the trigger
drove. Three fields carry the meaning, mapped straight from the take-action
triggers list (`src/transport/triggers.js`):

- **`agentRoutedTo`** — the L1 agent OMODA handed the incident to (e.g. `accident-agent`, `fire-agent`, `roadside`, `utility-agent`, `comms-agent`).
- **`incident`** — the incident type (e.g. `traffic-accident`, `fire`, `utility-hazard`).
- **`action`** — the action text from the trigger rule that fired (e.g. "coordinate the accident response (EMS, police)").

Plus `trigger` (the phrase that matched, or `null` when the model detected the
incident without a literal phrase) and `intentId` (groups it with the same
incident on the audit trail).

```
{ topic:"agent", at, agentRoutedTo:"accident-agent", incident:"traffic-accident",
  action:"coordinate the accident response (EMS, police)", trigger:"collision", intentId:"int_…" }
{ topic:"agent", at, agentRoutedTo:"fire-agent", incident:"fire",
  action:"coordinate the fire response (fire department, EMS)", trigger:"smoke", intentId:"int_…" }
{ topic:"agent", at, agentRoutedTo:"utility-agent", incident:"utility-hazard",
  action:"coordinate the infrastructure-hazard response (de-energize, gas shutoff)", trigger:"downed power line", intentId:"int_…" }
```

One event per NEW incident (not every frame of an ongoing one), and nothing for a
quiet frame. The full agent-to-agent choreography, the governed tool calls, who
approved, and the hash chain are on `/v1/out/audit` (condensed) and `/ui/audit`
(the full record). This stream answers "which agent is on what, and why"; the
audit trail is the record.

## The agentic narration stream (`/v1/out/agentic`)

Where `/v1/out/agents` is the thin ticker and `/v1/out/audit` is the durable
record, this stream is the story: what the agents are deciding, saying to each
other, and touching, as it happens.
The `event` field is a fixed catalog; new instrumentation only ADDS events, the
envelope never changes shape, so the dashboard can build against this today:

| `event` | Meaning | `detail` carries |
|---|---|---|
| `orchestration.route` | L0 decided who or what handles a request | `decision` (`tool-selected` / `no-tool`), `reason`, `model` |
| `agent.message` | one agent handing work to another | `handoff`, e.g. the judge handing an incident intent to L0, with `incidentType`, `severity`, `signals` |
| `tool.call` / `tool.result` | a declared tool invoked and what it returned | tool-specific, e.g. `coco.describe` prompt and bounded answer |
| `api.call` / `api.result` | an outbound API request and its response | `url`/`params`, then `latencyMs`, `ok`, bounded `body` |
| `inference.call` / `inference.result` | a model request and its outcome | `endpoint`, `purpose`, bounded `prompt`; then `latencyMs`, `usage`, bounded `output` |

`correlationId` pairs each call with its result. Every `detail` value is
size-bounded (~600 chars) with bearer tokens, auth headers, and base64 media
stripped before it leaves the process. Instrumented today: the inference client,
the L0 planner, the OpenClaw gateway client (L3), the `coco.describe` tool, and
the judge's incident handoffs; the ledger hook means anything not yet narrated
here still appears on `/v1/out/agents`.

## Backpressure and latency

The drop ceiling per subscriber IS the worst-case latency you watch at: a
consumer slower than the stream keeps its buffer pinned at the ceiling, and
ceiling divided by your throughput is your lag. So the ceilings are per topic:
**frames ~160 KB (about two frames)**, observations/agentic 512 KB, agents 1 MB.
A dashboard that cannot hold 30 fps sees a current picture with skipped motion,
never a delayed one. Frames are also relayed with zero re-encode (COCO's bytes
spliced into the envelope), so the hub adds no per-frame processing latency;
measured on the box, hub and direct-from-COCO deliver the same seq at the same
moment.

If the dashboard wants full 30 fps motion rather than a current picture, the
right architecture is: pull `/api/local/rgb-stream` DIRECT from COCO for pixels
(same hardware, that path already worked) and use this hub for what only it has:
observations with verdicts, the audit stream, and the agentic narration. The
frames endpoint stays for convenience and recording.

## Inputs, for reference

The hub consumes COCO at `OMODA_COCO_BASE` (`http://100.71.143.26:8091`):
`/api/local/rgb-stream` and `/api/observability` over WebSocket with reconnect
and backoff, and `GET /api/describe?prompt=...` as a declared, ledgered read
capability (`coco.describe`).


## Take-action triggers (admin-editable)

L0 checks every observation's text (description, question, answer) against a
curated phrase list in the ingest layer BEFORE any inference. A phrase hit routes
straight to the mapped L1 domain agent, deterministically, no model call. Text
that matches no phrase and shows no other signal is ignored; anything ambiguous
goes to the model to infer from the known agent skills. The operator curates the
phrases and their L1 targets at `/ui/triggers`, and uploads reference documents
at `/ui/knowledge`. Both are admin-portal pages behind Basic auth.
