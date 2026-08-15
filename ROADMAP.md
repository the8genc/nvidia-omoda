<!-- Concern: the strategic plan, workstreams, and acceptance gates for the judge-ready pipeline+webapp demo | Non-concern: the terminal verdict on the original bet (FINDINGS.md), the API wire format (webapp/CONTRACT.md), or per-unit evidence (results/*) | IO: none -->

# Privacy-Preserving Digital Twin — Roadmap

## The bet

A camera's raw feed is disposed at the edge and replaced by an anonymized 3D twin plus a privacy-safe scene-graph so the public sees only a simulated world, until a local agent watching that scene-graph against an open policy breaks the glass to reveal raw footage for a genuine public-safety emergency — and we own the twin and the agent-facing interface while a teammate owns the agent's decision logic.

## Standard of done

We nail our own half — twin, vocabulary, and interface — to "this simply couldn't be any better" before we take on any of the teammate's agent work.

## Governing principles

- Privacy is a property of the vocabulary: the approved schema is a closed vocabulary, so anything it does not declare (color, face, plate, identity, exact position) is unrepresentable by construction rather than a field suppressed later.
- The pipeline is a one-way chain of separated concerns — perception, then the scene-graph emitter that is the privacy boundary, then the sim builder, then render transport, then the rendering engine — with no stage reaching past the next.
- The sim builder is the single place a class becomes geometry, and the rendering engine is domain-blind: it draws only generic primitives it is handed and never branches on any domain class.
- Undistort is step 0, so segmentation, depth, and the point cloud all consume the same rectified frames back-projected with calibrated intrinsics rather than a guessed field of view.

## Current state

- Proven: the local GPU pipeline, segmentation, the neutral-oracle PII proof, the running in-browser app with all four panels, its passed professional/zero-slop UI/UX review, and metric depth validated as far flatter than the interim projection.
- In-flight: wiring the proper geometry into the live backend, the one-time fisheye calibration, and committing the app through the review gates.
- Not started: moving the class-to-geometry mapping off the renderer into the sim builder, real-time streaming, and an in-app raw-vs-twin PII comparison.

## Workstreams

### A — Pipeline geometry
Goal: the live 3D panel shows a flat, correctly-scaled scene on the fisheye camera instead of a warped guess.
- Calibrate the static camera once and undistort every frame as step 0.
- Adopt the validated metric-depth model for the point cloud, keeping the fast model as a fallback.
- Gate: a blind reviewer names the road, the vehicles, and a plausible flat 3D layout from a point-cloud render on untuned footage.

### B — The scene-graph emitter (the privacy boundary)
Goal: a per-frame scene-graph that can express only what the closed vocabulary declares, correct even if no sim is ever built downstream.
- Emit only vocabulary-declared classes, coarse zones, and allowed attributes, with everything else unrepresentable rather than filtered.
- Keep the approved schema shown and live-editable in the app so the public sees exactly what the camera may ever say.
- Gate: a neutral oracle inspecting only the emitted scene-graph can recover no identifying attribute because the vocabulary has no token for one.

### C — The sim builder and the dumb renderer
Goal: a public twin drawn as a simulation, with the only class-to-geometry decision living in the builder and none in the engine.
- Map each vocabulary class to a generic primitive in the sim builder and hand the renderer only posed, sized primitives over the render transport.
- Ship the first draft as a ground plane plus posed boxes, treating compelling models and precise orientation as explicit later polish.
- Gate: the render-engine code contains no domain-class term and passes the commit gate that forbids it from knowing what it renders.

### D — The web app
Goal: a professional, self-explaining app that works on any dropped video.
- Explain each pipeline stage in-app rather than merely display it.
- Verify an arbitrary unseen dataset drops in and renders end-to-end.
- Gate: it passes the UI/UX gate and a stranger understands each panel unled.

### E — Real-time (reach)
Goal: earn the live claim with a persistent streaming loop over the already-loaded models and rolling state.
- Gate: a real, displayed FPS/latency number, with any shortfall shown rather than hidden.

### F — Gates
Goal: independent review systems covering code and visuals with logged evidence.
- Run one commit gate for frontend TypeScript/Vue against the Vue3 and language-agnostic standards, and one for all Python against the language-agnostic standard.
- Enforce at the frontend gate the rule that the rendering engine never references a domain class.
- Gate: every wish-level deliverable carries a named, run gate — including the blind visual reviewer for geometry and UI/UX — with logged evidence.

### G — Privacy-escalation interface (our input, a teammate's agent)
Goal: expose the fast, privacy-safe interface a local watcher agent latches onto, without owning the agent's decision logic.
- Stream the vocabulary-bounded scene-graph over a short cyclic raw buffer as the agent's only routine input.
- Provide a break-glass reveal endpoint that time-boxes raw-frame access and logs every reveal.
- Gate: a teammate's agent subscribes to the scene-graph, confirms on a reveal-gated raw frame, and the app flips between the locked twin and the revealed feed.

## Critical path

1. Wire undistort and metric depth into the live backend and reprocess the primary dataset.
2. Blind-gate the point cloud on that dataset.
3. Move the class-to-geometry mapping into the sim builder so the renderer draws only generic primitives.
4. Add the explain-the-pipeline surface and commit the app through both code-review gates.
5. Verify an arbitrary dataset drops in and renders.
6. Pursue real-time only once the prior steps are solid.

## The single biggest risk

The rendering engine still decides geometry per domain class, so the privacy boundary and the separation of concerns are asserted in the vocabulary but not yet true in the code that judges will read.
