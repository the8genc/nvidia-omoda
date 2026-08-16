# Dashboard integration: the city-services layer

For the engineer building the CCTV command-center dashboard. This is the read
side of the mock external service layer: what you can pull, the exact JSON, how
often to poll, and which calls are OpenShell-gated (so the dashboard can show the
danger boundary the platform enforces).

You do not place dispatches from the dashboard. The agents do that, under
OpenShell governance. The dashboard reads state and renders it.

## Base URL and auth

- **Base:** `http://100.71.143.26:3120`
- **Auth:** none. Every consumer runs on the same box; the service binds the
  tailnet address so the dashboard reaches it directly. Do not send a token.
- **Health:** `GET /health` -> `{"ok":true,"service":"city-services-mock"}`.
  Poll it for a connection indicator.
- **CORS / content type:** every response is `application/json` with
  `cache-control: no-store`. Poll; do not cache.

## What to pull

### The catalog (render the danger boundary)

`GET /api/catalog` returns every route with its backing tool and, read live from
the skills manifest, whether the call is OpenShell-protected. Use it to drive a
legend or a per-action badge, so the labelling on the dashboard can never drift
from the real policy.

```json
{
  "service": "OMODA mock city-services layer",
  "routes": [
    { "method": "POST", "path": "/api/dispatch", "tool": "dispatch.unit.request",
      "verb": "create", "impact": ["legal"], "consent": "approval",
      "openshell_protected": true,
      "summary": "request a unit (fire/EMS/police) to an incident" }
  ]
}
```

`openshell_protected: true` means the call does not exist until a human decision
records; `false` means it runs unattended and ledgered. Badge the protected ones.

### Fleet status (poll ~5s)

`GET /api/dispatch/units` -> every unit and whether it is `available` or
`deployed`. A unit flips to `deployed` while it is assigned to a live call.

```json
{ "units": [
  { "unit_id": "E-17", "type": "fire engine", "service": "fire",
    "home": "Station 17", "status": "deployed" },
  { "unit_id": "M-2", "type": "ambulance", "service": "ems",
    "home": "Harborview", "status": "available" }
] }
```

### A live call (poll ~2-3s while on screen)

`GET /api/dispatch/{call_id}` -> one dispatched call. `status` walks
`routing` (first 5s) -> `en_route` (ETA counts down) -> `on_scene`
(`eta_seconds` hits 0). `cancelled` if the callout was cancelled.

```json
{ "call_id": "CAD-0001", "service": "fire", "routed_to": "Seattle Fire Dispatch",
  "status": "on_scene",
  "units": [ { "unit_id": "E-17", "type": "fire engine", "from": "Station 17",
               "eta_seconds": 0, "distance": "on scene" } ],
  "eta_seconds": 0, "elapsed_seconds": 487,
  "incident": "structure fire, visible flames", "location": "5th & Pine",
  "placed_at": "2026-08-16T13:46:51.859Z" }
```

You get `call_id` values from the agent-action stream (see below); you do not
create calls from the dashboard.

### Road segment condition (poll on demand)

`GET /api/roads/segments/{id}` -> a segment's surface, open lanes, obstruction.

```json
{ "segment_id": "SR-99-NB-42", "surface": "dry", "lanes_open": 2,
  "lanes_total": 3, "obstruction": "partial",
  "updated_at": "2026-08-16T13:54:59.537Z" }
```

### A work order (poll ~10s)

`GET /api/roads/workorders/{id}` -> a roadside/DOT job. `status` walks
`scheduled` -> `crew_dispatched` -> `on_site` -> `complete`.

```json
{ "work_order_id": "WO-0002", "type": "debris", "segment": "SR-99-NB-42",
  "status": "crew_dispatched",
  "crew": { "unit_id": "TOW-4", "type": "tow truck", "eta_seconds": 713 },
  "opened_at": "2026-08-16T13:46:51.940Z" }
```

## Where the IDs come from

The dashboard should not guess `call_id` / `work_order_id`. They surface on the
OMODA output streams, which are also no-auth on this box:

- `ws://100.71.143.26:3111` and `GET /v1/out/agents` (port 3110): the human-prose
  agent-action stream. When emergency-dispatch executes a dispatch, the action
  narration carries the tool and the resulting call. Read the ID from there, then
  poll the status endpoint above.
- `GET /v1/out/agentic`: the structured agentic stream (orchestration calls,
  tool calls, API responses) if you want machine-readable events instead of prose.

Full stream contract: `docs/demo-stream-contract.md`.

## Rendering the danger boundary (the demo point)

The story the dashboard should tell: reads stream freely, and the two calls that
put a real-world response in motion are the ones held for a human.

- **Open, unattended:** all `GET` reads, and `POST /api/roads/workorders`
  (reversible, ledgered, auto-UNDO).
- **OpenShell-gated:** `POST /api/dispatch` (approval) and
  `DELETE /api/dispatch/{call_id}` (two-person). The write responses carry
  `dangerous: true`.

Pull `/api/catalog` and badge each action by `openshell_protected`. When a
dispatch is pending human approval, the agent stream shows it held; the dashboard
can show the same call go from "awaiting approval" to a live `call_id` the moment
the operator approves. That transition is the product.

## More surfaces (same base, same no-auth, same catalog)

The platform now fronts five service domains. All reads below are open and
pollable; the writes are agent-driven and OpenShell-gated (badge them from
`/api/catalog` like the rest).

- **Procurement / finance:** `GET /api/procurement/vendors` (private vendors on
  contract, hourly rate, availability); `GET /api/procurement/callouts/{id}`
  (a callout's status and `running_cost`, walks `authorized -> dispatched -> on_site`).
- **Utility / infrastructure:** `GET /api/utility/segments/{id}`
  (`energized`, `gas_flowing`, `load`, `hazard`); state flips when an agent
  de-energizes or restores.
- **Surveillance / evidence:** `GET /api/evidence/clips/{id}` (a clip's custody
  status, `held` or `retracted`). Camera steering (`PUT /api/cameras/ptz`) is
  agent-driven.
- **Public-safety comms:** `GET /api/comms/channels` (advisory board and
  reverse-911 zones with audience size).

These make good dashboard panels: a live "public spend so far" counter from the
procurement callouts, a grid map from the utility segments, and an evidence-locker
list. The catalog badges each write by `openshell_protected`, so the demo can show
a crane callout (financial), a block de-energize (infrastructure), and an evidence
export (privacy) each waiting on a human, alongside the emergency dispatch.

## Quick poll loop (reference)

```js
const BASE = "http://100.71.143.26:3120";
async function poll(callId) {
  const r = await fetch(`${BASE}/api/dispatch/${callId}`, { cache: "no-store" });
  if (r.status === 404) return null;          // unknown / not yet created
  return r.json();                            // {status, units, eta_seconds, ...}
}
setInterval(async () => {
  const fleet = await (await fetch(`${BASE}/api/dispatch/units`)).json();
  render(fleet.units);
}, 5000);
```

`GET /api/catalog` lists every route; a 404 on any path returns
`{ "error": "...", "hint": "GET /api/catalog lists every route" }`.
