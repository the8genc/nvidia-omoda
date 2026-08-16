# The output streams: what the demo app consumes

OMODA is the hub. It consumes COCO's live interface (frames, descriptions, the
describe API) and republishes everything the demo needs on three WebSocket
endpoints, plus the one thing only OMODA can provide: realtime agent activity.

## Endpoints

All on the stream server (`ws://100.71.143.26:3111` on the box), all requiring
`Authorization: Bearer <viewer token>` on the upgrade. The viewer token holds
`intent:read` and nothing else: the demo app can watch the platform and cannot
drive it. The token prints once at boot (`viewer ...`); ask and we hand it over.

| Endpoint | One message per | Shape |
|---|---|---|
| `/v1/out/frames` | video frame | `{topic:"frame", at, seq, index, rgb}` where `rgb` is the JPEG data URI relayed verbatim from COCO |
| `/v1/out/observations` | COCO description | `{topic:"observation", at, source, description, prompt, followup, danger_signal, verdict, intentId?, incidentType?, severity?, signals?}` |
| `/v1/out/agents` | ledgered action | `{topic:"agent", at, entry}` where `entry` is the full hash-chained ledger record: seq, agent, tool, verb, tier, outcome, authority, intentId, hash |

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
