---
skill: coco
agent: perception
level: 3
capabilities:
  - tool: coco.describe
    verb: read
    resource: coco:camera
    impact: []
    egress: { host: 100.71.143.26, port: 8091, path: "/api/describe*" }
  - tool: coco.observability.read
    verb: read
    resource: coco:observations
    impact: []
    egress: { host: 100.71.143.26, port: 8091, path: "/api/observability" }
  - tool: coco.frames.read
    verb: read
    resource: coco:frames
    impact: []
    egress: { host: 100.71.143.26, port: 8091, path: "/api/local/rgb-stream" }
---
Pure connectivity to the COCO perception platform on this box. Reads only:
ask the camera a question (describe), consume the description stream, relay the
frame stream. This agent receives tool-specific requests and no task context;
judgment about what any observation means belongs to the Observation Judge.
