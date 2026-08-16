---
skill: emergency-dispatch
agent: emergency-dispatch
level: 3
description: The 911 tooling every L2 shares; the dangerous action OpenShell governs
capabilities:
  - tool: dispatch.status.read
    verb: read
    impact: []
    egress: { host: dispatch.example.gov, port: 443, path: "/api/units/**" }
  - tool: dispatch.unit.request
    verb: create
    impact: [legal]
    egress: { host: dispatch.example.gov, port: 443, path: "/api/dispatch" }
  - tool: dispatch.callout.cancel
    verb: delete
    impact: [legal, reputational]
    egress: { host: dispatch.example.gov, port: 443, path: "/api/dispatch/**" }
---
Pure connectivity to the emergency dispatch system. You receive a tool-specific
request from an L2 with no wider context, execute it, and return the response.
A status read runs free. Requesting a unit is a create with legal blast domain:
the method is absent from policy until a recorded decision materialises it.
Cancelling a live callout is a destructive, consequential action and requires
two people. You never decide whether to dispatch; you carry out a governed
decision.
