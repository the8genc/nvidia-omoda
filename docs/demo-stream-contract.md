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
| `/v1/out/agents` | agent action | `{topic:"agent", at, name, level, action, instruction, outcome, tier, seq}` — a compact display projection (see below) |
| `/v1/out/agentic` | agentic event | `{topic:"agentic", at, event, correlationId, actor, target?, intentId?, detail}` — the fine-grained narration stream, catalog below |

## What the observation verdicts mean

- `nominal`: quiet footage; no signals fired, no model consulted.
- `judged-nominal`: signals fired, Nemotron judged it not an incident.
- `incident`: an intent was opened; `intentId`, `incidentType`, `severity` present.
- `attached`: another observation of an already-open incident (`occurrences`).
- `candidate-skipped-busy`: a candidate arrived while a judgment was in flight;
  recorded and skipped so OMODA never queues behind COCO's captioning.

## What the agent stream shows

Every action the platform records, as it lands: `judge.incident`,
`judge.resolve`, broker admits and refusals (including `prohibited`),
`telegram.decide`, `ui.agent.deploy`, gateway calls, `coco.describe` questions.
The demo app renders this as the live "what are the agents doing" panel; the
`tier` field (safe, contained, consequential, prohibited) is the color coding.

## The agent-action stream (`/v1/out/agents`)

Human-prose, for display. Each event leads with a `headline` sentence describing
what is happening in the flow right now; the structured fields are there for the
UI to style, but the sentence is the point. Every hop down the org chart is a
separate event: OMODA (L0) handing to a domain expert (L1), an L1 to a worker
(L2), a worker to the tool specialist (L3).

Two `kind`s:

**`handoff`** — one agent relying on another:
```
{ topic:"agent", at, kind:"handoff", intentId,
  headline:"OMODA handed off to the fire domain expert (L1) to take the fire and coordinate the response.",
  agent:   { name:"l0", level:0, role:"orchestrator" },
  relies_on:[{ name:"fire", level:1, role:"domain expert" }],
  doing:"take the fire and coordinate the response",
  dangerous:false }
```
A dangerous hop (the 911 calls) sets `dangerous:true` and the headline says it is
held for human approval.

**`action`** — one agent doing a ledgered thing:
```
{ topic:"agent", at, kind:"action", seq, intentId,
  headline:"The emergency dispatch tool specialist (L3) needs human approval before it can dispatch.unit.request; the capability does not exist until then.",
  agent:{ name:"emergency-dispatch", level:3, role:"tool specialist" },
  action:"create dispatch.unit.request", instruction:"…", outcome:"escalated", tier:"consequential" }
```

`level` is the org-chart rank (`0`–`3`), `"operator"` for the human, `"input"`
for a camera/See feed. L0 is named **OMODA** in prose, since that is the
interface. The full hash-chained record stays on disk and on `GET /v1/ledger`,
one `seq` away; this stream is for the story, the ledger is for the proof.

## The agentic narration stream (`/v1/out/agentic`)

Where `/v1/out/agents` is the audit (durable, terse), this stream is the story:
what the agents are deciding, saying to each other, and touching, as it happens.
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
