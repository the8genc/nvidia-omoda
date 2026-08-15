<!-- Concern: the strategic plan, workstreams, and acceptance gates for the judge-ready pipeline+webapp demo | Non-concern: the terminal verdict on the original bet (FINDINGS.md), the API wire format (webapp/CONTRACT.md), or per-unit evidence (results/*) | IO: none -->

# Privacy-Preserving Digital Twin — Roadmap

## The bet

A camera's raw feed is disposed at the edge and replaced by an anonymized 3D twin plus a privacy-safe scene-graph so the public sees only a simulated world, until a local agent watching that scene-graph against an open policy breaks the glass to reveal raw footage for a genuine public-safety emergency — and we own the twin and the agent-facing interface while a teammate owns the agent's decision logic.

## Governing principle

Undistort is step 0, so segmentation, depth, and the point cloud all consume the same undistorted frames, back-projected with calibrated intrinsics rather than a guessed field-of-view.

## Current state

- Proven: the local GPU pipeline, segmentation, the neutral-oracle PII proof, the running in-browser app with all four panels, its passed professional/zero-slop UI/UX review, and metric depth validated as far flatter than the interim projection.
- In-flight: wiring the proper geometry into the live backend, the one-time fisheye calibration, and committing the app through the review gate.
- Not started: real-time streaming, and an in-app raw↔twin PII comparison.

## Workstreams

### A — Pipeline geometry
Goal: the live 3D panel shows a flat, correctly-scaled scene on the fisheye camera instead of a warped guess.
- Calibrate the static camera once and undistort every frame as step 0.
- Adopt the validated metric-depth model for the point cloud, keeping the fast model as a fallback.
- Gate: a blind reviewer names the road, the vehicles, and a plausible flat 3D layout from a point-cloud render on untuned footage.

### B — The web app
Goal: a professional, self-explaining app that works on any dropped video.
- Render the anonymized twin as generic primitives — one generic model per class — so the public view is a simulation, not the footage or even the raw points.
- Explain each pipeline stage in-app rather than merely display it.
- Verify an arbitrary unseen dataset drops in and renders end-to-end.
- Gate: it passes the UI/UX gate, the code-review gate, and a stranger understands each panel unled.

### C — Real-time (reach)
Goal: earn the live claim with a persistent streaming loop over the already-loaded models and rolling state.
- Gate: a real, displayed FPS/latency number, with any shortfall shown rather than hidden.

### D — Gates
Goal: two independent review systems — code-review at commit, and the blind visual reviewer for geometry and UI/UX.
- Gate: every wish-level deliverable carries a named, run gate with logged evidence.

### E — Privacy-escalation interface (our input, a teammate's agent)
Goal: expose the fast, privacy-safe interface a local watcher agent latches onto, without owning the agent's decision logic.
- Own the approved-schema — shown and live-editable in the app — that declares the allowed classes and attributes and thereby drives what the scene-graph and twin emit.
- Stream a per-frame scene-graph of classes and coarse zones only — never identity, face, or exact location — over a short cyclic raw buffer.
- Provide a break-glass reveal endpoint that time-boxes raw-frame access.
- Gate: a teammate's agent subscribes to the scene-graph, confirms on a reveal-gated raw frame, and the app flips between the locked twin and the revealed feed.

## Critical path

1. Wire undistort and metric depth into the live backend and reprocess the primary dataset.
2. Blind-gate the point cloud on that dataset.
3. Add the explain-the-pipeline surface and commit the app through the code-review gate.
4. Verify an arbitrary dataset drops in and renders.
5. Pursue real-time only once the prior steps are solid.

## The single biggest risk

The live app still serves the interim geometry, so the 3D panel that judges scrutinize first warps at the edges until step 1 lands.
