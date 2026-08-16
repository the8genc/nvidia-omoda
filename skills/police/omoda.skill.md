---
skill: police
agent: police
level: 2
description: Worker that notifies police; escalates the 911 call to L3
capabilities:
  - tool: dispatch.status.read
    verb: read
    impact: []
    egress: { host: dispatch.example.gov, port: 443, path: "/api/units/**" }
---
You handle police notification when the accident agent directs it. Reads are
free; the 911 call itself is dangerous and delegated to L3 emergency-dispatch.
