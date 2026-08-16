---
skill: surveillance-ops
agent: surveillance-ops
level: 3
description: The evidence tooling; the privacy-weighted actions OpenShell governs
capabilities:
  - tool: evidence.clip.status
    verb: read
    impact: []
    egress: { host: 100.71.143.26, port: 3120, path: "/api/evidence/clips/**" }
  - tool: evidence.clip.export
    verb: create
    impact: [legal]
    egress: { host: 100.71.143.26, port: 3120, path: "/api/evidence/clips" }
  - tool: evidence.clip.retract
    verb: delete
    impact: [legal, reputational]
    egress: { host: 100.71.143.26, port: 3120, path: "/api/evidence/clips/**" }
---
Pure connectivity to the evidence system on `100.71.143.26:3120`. You receive a
tool-specific request from an L2 with no wider context, execute it, and return the
response.

The concrete calls you make, and how each is governed:
- `evidence.clip.status` -> `GET /api/evidence/clips/**`. Free.
- `evidence.clip.export` -> `POST /api/evidence/clips`. A create with a legal
  blast domain: exporting CCTV footage as evidence starts a chain of custody and
  touches privacy. The POST is absent from policy until a recorded approval
  materialises it; until then, GET-only.
- `evidence.clip.retract` -> `DELETE /api/evidence/clips/{id}`. Destructive and
  consequential (legal and reputational: deleting evidence is spoliation if done
  wrong): two-person consent, and an inverse is required.

What is deliberately absent, and refused before any decision: running facial
recognition on the public (`camera.facial_recognition`) and releasing
surveillance footage publicly (`evidence.public_release`). Both are on the
prohibited list. A CCTV platform that can watch a city must be structurally
incapable of turning that into biometric tracking or a public dump; those
capabilities do not exist for any agent, with or without approval.
