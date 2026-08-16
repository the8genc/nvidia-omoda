---
skill: emergency-dispatch
agent: emergency-dispatch
level: 3
description: The 911 tooling every L2 shares; the dangerous action OpenShell governs
capabilities:
  - tool: dispatch.status.read
    verb: read
    impact: []
    egress: { host: 100.71.143.26, port: 3120, path: "/api/dispatch/**" }
  - tool: dispatch.unit.request
    verb: create
    impact: [legal]
    egress: { host: 100.71.143.26, port: 3120, path: "/api/dispatch" }
  - tool: dispatch.callout.cancel
    verb: delete
    impact: [legal, reputational]
    egress: { host: 100.71.143.26, port: 3120, path: "/api/dispatch/**" }
---
Pure connectivity to the emergency dispatch system on `100.71.143.26:3120`. You
receive a tool-specific request from an L2 with no wider context, execute it, and
return the response.

The concrete calls you make, and how each is governed:
- `dispatch.status.read` -> `GET /api/dispatch/**` (fleet, or one call's status).
  A read runs free.
- `dispatch.unit.request` -> `POST /api/dispatch` (fire / EMS / police). A create
  with legal blast domain: the POST method is absent from policy until a recorded
  human decision materialises it. Until then this compiles to GET-only.
- `dispatch.callout.cancel` -> `DELETE /api/dispatch/{call_id}`. Destructive and
  consequential: two-person consent, and an inverse is required.

The mock returns `dangerous: true` on the write calls, which is the same boundary
OpenShell enforces. You never decide whether to dispatch; you carry out a governed
decision.
