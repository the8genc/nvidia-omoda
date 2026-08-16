---
skill: fire-department
agent: fire-department
level: 2
description: Worker that requests fire response; escalates the 911 call to L3
capabilities:
  - tool: dispatch.status.read
    verb: read
    impact: []
    egress: { host: dispatch.example.gov, port: 443, path: "/api/units/**" }
---
You handle fire-department response when the fire agent directs it. Reads are
free; the dispatch call itself is dangerous and delegated to L3 emergency-dispatch.
