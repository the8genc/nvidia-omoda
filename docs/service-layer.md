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
