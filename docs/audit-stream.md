# The agentic audit trail

Two tiers over one source of truth, the hash-chained action ledger
(`src/ledger/ledger.js`):

1. **The condensed stream** (`/v1/out/audit`) for the demo dashboard: a fixed
   eight-field record per agent engagement, live over WebSocket, no auth. This
   document.
2. **The robust audit DB page** (`/ui/audit`, admin login) for a human operator
   doing deeper analysis: every field the ledger holds, filterable, with the raw
   hash-chained record and the chain-integrity state. See "The admin audit DB"
   below.

The stream is intentionally a projection, not the whole record. It exists so the
dashboard can render fast; it is not the system of record. Anything the dashboard
does not show is still in the ledger and on the admin page.

## The condensed stream

- **Where:** `ws://100.71.143.26:3111/v1/out/audit` (and readable over the same
  stream server as the other output topics).
- **Auth:** none. Same-hardware consumer, like the other `/v1/out/*` streams.
- **Backed by:** the ledger. Durable rows carry `seq` and `hash`; agent-to-agent
  handoffs carry the flow. Projection: `src/telemetry/audit.js`.

## What is and isn't in it

The trail begins when **OMODA (L0) sees something that triggers it**. A motor
quietly reviewing frames that trigger nothing never appears: quiet frames are
never written to the ledger, and perception, knowledge, and admin reads are
filtered out. From the trigger onward, **every L1 -> L2 -> L3 engagement** is
captured: the routing decision, each handoff, and each governed tool call with its
outcome and who authorised it.

## Record shape

Every message is one JSON object with these fields:

```json
{
  "time": "2026-08-16T04:00:00.000Z",
  "agent": { "name": "emergency-dispatch", "display": "the emergency dispatch tool specialist (L3)" },
  "tool": "dispatch.unit.request",
  "trigger": { "verb": "create", "noun": "unit", "phrase": "collision" },
  "tier": { "level": 3, "label": "L3", "role": "tool specialist" },
  "authority": { "kind": "operator", "who": "arif", "ref": "d-42" },
  "outcome": "executed",
  "intent": { "id": "int-9", "why": "respond to traffic-accident at coco-live" },
  "source": "ledger",
  "seq": 12,
  "hash": "9f2c..."
}
```

| Field | Meaning |
|---|---|
| `time` | When the event took place (ISO 8601). |
| `agent` | `name` is the raw agent id; `display` is the human phrase for the UI. |
| `tool` | The tool used. `null` for a handoff (a delegation, not a tool call). |
| `trigger` | The trigger word, split: `verb` is the CRUD verb (or `delegate`/`route`), `noun` is the resource, `phrase` is the take-action word that opened the incident (present on the origin row). |
| `tier` | The agent's rank: `level` 0-3 (or `"operator"`/`"input"`), and a `label` (`L0`..`L3`). |
| `authority` | Who authorised it. `kind: "operator"` with a `who` (the person who approved) for a consented action; `kind: "envelope"` for an autonomous one; `kind: "pending"` while awaiting approval; `kind: "denied"`/`"prohibited"` for a refusal. |
| `outcome` | What happened: `executed`, `refused`, `awaiting-approval`, `handed-off`, `undone`, `routed-to-l1`, etc. |
| `intent` | Why the agent acted: `id` groups every row of one incident; `why` is the reason text. |
| `source` | `"ledger"` for a durable, hash-chained audit row (has `seq`/`hash`); `"engagement"` for an agent-to-agent handoff. |
| `seq`, `hash` | The ledger sequence and chain hash. Present only on `source: "ledger"` rows, so the demo can prove a row is a real audit record. |

## Reading it in the demo

- **Group by `intent.id`** to assemble one incident's full story: the L0 trigger
  (with `trigger.phrase`), the handoffs down the org chart, and the governed tool
  calls at the bottom.
- **Colour by `authority.kind`**: `envelope` (green, autonomous), `pending`
  (amber, waiting on a human), `operator` (blue, a person approved, with `who`),
  `denied`/`prohibited` (red).
- **The origin row** of an incident is the one with `tier.label === "L0"`; its
  `trigger.phrase` is the word that started everything.
- A `source: "ledger"` row with a `hash` is a durable audit record; you can cross
  reference it against `GET /v1/ledger` by `seq`.

## Example: one collision, end to end

```
L0   collision            route -> accident            (routed-to-l1, intent int-9)
L1   accident  delegate    -> ambulatory               (handed-off)
L2   ambulatory delegate   -> emergency-dispatch        (awaiting-approval)   dangerous
L1   accident  delegate    -> police                    (handed-off)
...  procurement, evidence handoffs ...
L3   emergency-dispatch  create dispatch.unit.request   (executed, authority operator: arif)
```

All rows share `intent.id: "int-9"`, so the dashboard renders them as one incident.

## The admin audit DB (`/ui/audit`)

Behind the admin login. This is the operational record, not a display: it shows
every field the ledger stores, which is more than the stream carries. Use it to
review an incident after the fact, prove integrity, or investigate a refusal.

Per row, beyond the eight stream fields:

- `seq`, `hash`, `prevHash` : the hash chain. The page verifies the whole chain on
  load and shows `chain verifies, N entries` or the seq where it broke.
- `argsHash` : a hash of the call arguments (the args themselves are never stored,
  so the trail is evidence without being a data-exfiltration surface).
- `target` : the concrete external call the broker governed, e.g.
  `POST 100.71.143.26/api/dispatch`.
- `intentId` : links every row of one incident, including the L3 tool calls.
- `decidedBy` / `authority` : who approved and under which decision.
- `rule` : for a refusal, the exact prohibited rule that fired
  (`no-mass-broadcast`, `gateway-self-protection`, …).
- `tier` / `kind` : the broker classification (safe/contained/consequential/
  prohibited) or the event kind (orchestrator, judge, undo, …).
- the full raw JSON of the entry, one click away under each row.

Filters (query string, also the on-page form): `intent`, `agent`, `tier`,
`outcome`, `verb`, `since` (ISO), `limit`. Example:
`/ui/audit?intent=int-9` reconstructs one incident end to end;
`/ui/audit?outcome=refused` lists every refusal.

The same records are available as JSON at `GET /v1/ledger` (bearer token, the
`ledger` scope), for programmatic review.

## Design note: robust DB, condensed stream

The ledger is written and fsynced **before** each action runs, so a crash between
deciding and acting still leaves evidence. It records what is needed to operate
and audit the system, not only what the dashboard displays: incident linkage, the
concrete target, who approved, the prohibited rule on a refusal, and the hash
chain. The dashboard pulls the condensed view it needs from the stream; an
operator pulls the full picture from `/ui/audit`.
