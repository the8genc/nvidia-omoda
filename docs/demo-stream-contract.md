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
| `/v1/out/agents` | ledgered action | `{topic:"agent", at, entry}` where `entry` is the full hash-chained ledger record: seq, agent, tool, verb, tier, outcome, authority, intentId, hash |
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

## Backpressure

Frames are ~55 KB each. A subscriber whose socket buffer exceeds 2 MB gets
frames dropped rather than queued: a realtime view that lags a minute is worse
than one that skips. Drops are per-subscriber and recover as soon as the buffer
drains. If the demo app only needs the picture occasionally, subscribe to
`/v1/out/frames` on demand and stay on the other two.

## Inputs, for reference

The hub consumes COCO at `OMODA_COCO_BASE` (`http://100.71.143.26:8091`):
`/api/local/rgb-stream` and `/api/observability` over WebSocket with reconnect
and backoff, and `GET /api/describe?prompt=...` as a declared, ledgered read
capability (`coco.describe`).
