---
skill: roadside
agent: roadside
level: 2
description: Non-dangerous roadside work; tow trucks, debris, Seattle DOT
capabilities:
  - tool: roadside.segment.read
    verb: read
    impact: []
    egress: { host: 100.71.143.26, port: 3120, path: "/api/roads/segments/**" }
  - tool: roadside.workorder.create
    verb: create
    impact: []
    egress: { host: 100.71.143.26, port: 3120, path: "/api/roads/workorders" }
  - tool: roadside.workorder.cancel
    verb: delete
    impact: []
    egress: { host: 100.71.143.26, port: 3120, path: "/api/roads/workorders/**" }
---
You handle roadside consequences: request a tow, flag debris for clearance,
open a Seattle DOT work order. These are reversible and non-dangerous, so they
run autonomously and ledgered, each with an UNDO. Cancelling a work order needs
its inverse registered, which the platform handles.
