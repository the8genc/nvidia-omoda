# The mock external service layer

A standalone service that stands in for the city and private services an agent
would call in production, so the demo shows the full agent flow, call out, get
JSON back, poll live status, without placing a single real emergency call.

- **Where:** `src/mock/city-services.js`, run by `src/mock/serve-city.js`, on
  `:3120` (inside our 3100-3199 block). On the box: `city-services.service`.
- **What it fronts:** 911 dispatch (fire / EMS / police), roadside and Seattle
  DOT. One gateway obfuscating several services, which is what an agent sees.

## Routes

| method | route | backing tool | protected |
|---|---|---|---|
| GET | `/api/dispatch/units` | dispatch.status.read | no (read) |
| POST | `/api/dispatch` | dispatch.unit.request | **yes** (create + legal) |
| GET | `/api/dispatch/{call_id}` | dispatch.status.read | no (read) |
| DELETE | `/api/dispatch/{call_id}` | dispatch.callout.cancel | **yes** (two-person) |
| GET | `/api/roads/segments/{id}` | roadside.segment.read | no |
| POST | `/api/roads/workorders` | roadside.workorder.create | no (reversible) |
| GET | `/api/roads/workorders/{id}` | roadside.workorder.create | no |
| DELETE | `/api/roads/workorders/{id}` | roadside.workorder.cancel | no |
| POST | `/api/incidents` | incident.record.create | **yes** (approval) |
| GET | `/api/incidents/{id}` | incident.status.read | no (read) |
| DELETE | `/api/incidents/{id}` | incident.record.retract | **yes** (two-person) |
| POST | `/api/notify` | supervisor.notify | **yes** (review) |

Every route above resolves to a tool declared in a skills manifest, and every
agent's egress points here. There are no calls to external endpoints in any
manifest except the two genuinely separate platforms on this box: COCO perception
(`:8091`) and the OpenClaw gateway (`:18789`). Everything an agent does to the
outside world goes through this one service layer, which is the tier OpenShell
governs and, in production, the tier that would route each call to its real
backend. Applying the taxonomy here is the point: OpenShell protects calls to
external resources at a middle layer of the stack, not only at the tool edge.

`GET /api/catalog` returns this table live, and the `openshell_protected` flag is
read from the actual skills manifest, so what the mock calls dangerous is exactly
what the platform gates. Reads are open; the writes that dispatch or cancel a
real-world response are the protected ones.

## Live status

`POST /api/dispatch` returns a `call_id`, the routed service, the assigned unit,
and an ETA. `GET /api/dispatch/{call_id}` is pollable and evolves against the
clock: `routing` (first 5s) -> `en_route` (ETA counts down) -> `on_scene`.
Fleet status (`/api/dispatch/units`) flips a unit to `deployed` while its call is
active. Work orders evolve `scheduled` -> `crew_dispatched` -> `on_site` ->
`complete`. ETAs are fixed per service so a demo is repeatable.

The agents reach it because the emergency-dispatch and roadside manifests declare
their egress to `100.71.143.26:3120`, so OpenShell governs the call: a read goes
straight through, a dispatch write is absent from policy until a recorded human
decision materialises it.

## How the agents know what they can call

Two paths carry this, and they are kept in sync:

1. **The planner catalog.** When OMODA plans an action, the model is handed every
   declared tool with its verb, blast domain, owning agent, the concrete API it
   reaches, and whether it is OpenShell-gated (`src/models/plan.js`,
   `renderCatalog`). The model only NAMES a tool; the endpoint and the gate are
   context, never authority. A tool that is not in this catalog is undeclared, and
   undeclared is denied.
2. **The skill bodies.** Each agent's `omoda.skill.md` prose names the concrete
   endpoints it (or its downstream L3) acts on and which are gated, so the agent's
   own instructions match the live service layer.

## Trigger -> scenario -> endpoint -> protection

This is the full path from a CCTV observation to a governed call. OMODA matches an
observation's text against the take-action triggers (`src/transport/triggers.js`),
routes to the L1, which runs the response plan (`src/domain/response-plan.js`) down
to the L3 that holds the egress.

| Trigger phrases | L1 (OMODA routes to) | L2 worker | L3 call | Endpoint | OpenShell |
|---|---|---|---|---|---|
| crash, collision, wreck, rear-ended, T-boned, hit and run | accident | ambulatory | dispatch.unit.request (ems) | `POST /api/dispatch` | **approval** |
| injured, person down, pedestrian struck, unconscious | accident | ambulatory | dispatch.unit.request (ems) | `POST /api/dispatch` | **approval** |
| (accident, police needed) | accident | police | dispatch.unit.request (police) | `POST /api/dispatch` | **approval** |
| fire, smoke, flames, ablaze, explosion, burning | fire | fire-department | dispatch.unit.request (fire) | `POST /api/dispatch` | **approval** |
| (fire, injuries) | fire | ambulatory | dispatch.unit.request (ems) | `POST /api/dispatch` | **approval** |
| fallen sign, debris, obstruction, blocked lane, tree branch | roadside | roadside | roadside.workorder.create | `POST /api/roads/workorders` | none (auto-UNDO) |
| pothole, road damage, flooding, sinkhole, washed out | roadside | roadside | roadside.workorder.create | `POST /api/roads/workorders` | none (auto-UNDO) |

Reads that ground the decision (`GET /api/dispatch/**`, `GET /api/roads/segments/**`,
`GET /api/roads/workorders/**`) run unattended at every level. Cancelling a live
callout (`DELETE /api/dispatch/{call_id}`) is two-person.

The triggers are editable from the admin portal (`/ui/triggers`), so the operator
can add a phrase or repoint it to a different L1 without a redeploy; the mapping
above is the seeded default.

## For dashboard engineers

See `docs/dashboard-integration.md`: the read/pollable endpoints, exact JSON
shapes, poll cadence, and how to render the OpenShell danger boundary.
