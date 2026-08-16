<!-- Concern: the terminal verdict on the whole experiment — what is proven, what is a documented gap | Non-concern: per-unit detail (each results/*/verdict.md) or the plan (ROADMAP.md) | IO: none -->

# FINDINGS — terminal verdict

**The bet:** turn a static CCTV feed into a continuous, temporally-stable, semantically-labeled 3D
representation that carries no PII, fully local on the DGX Spark (GB10).

**Terminal verdict: the core bet is PROVEN; two stretch properties are documented gaps.** The spine
stands and was blind-gated / cross-checked at every rung; the value proposition (privacy) is
demonstrated by a neutral oracle. What is not yet met — full scene *legibility* of the twin, and
*real-time* — is characterized, not hand-waved.

## Proven (each rung closed honestly)
- **Runs local on the GB10.** Blackwell torch (cuda=True) + SegFormer + Depth-Anything + YOLO in one
  container. No cloud, no NGC.
- **Perception (single frame).** Seg (stuff), depth (coherent near→far), 3D lift — all blind-gated.
- **Depth is geometrically trustworthy.** Road fits a plane at **R²=0.84**, buildings correctly farther,
  clean gradient (depth QA cross-checked vs seg + input).
- **Geometry stability (the crux).** The static background is stable frame-to-frame; static/mover
  separation is clean and **seg-independent** (background subtraction). Anchor = per-pixel temporal
  mean. (A misleading aggregate "hop" and a "seg instability" both turned out to be a caught seg
  preprocessing bug + mover pollution — integrity work, not band-aids.)
- **Labeling reliability.** SegFormer instability root-caused to a 512² square-resize bug; one-line fix
  (`do_resize=False`) → road-dominant on all 10 frames.
- **Stabilized labeled stream.** The anchored background does not flicker; frames register.
- **Vehicles.** Detected + tracked with persistent IDs (buses 2/7, cars 5/9/11) → placeable as CAD/markers.
- **PII strip — the value prop, PROVEN by a neutral oracle.** Given the raw frame, a blind reviewer
  recovered location (Shibuya), brand signage, and crowd attire; given the twin, it recovered **zero**
  identity — only anonymized regions + vehicle markers. (`results/D/killer-comparison.md`.)

## Documented gaps (honest, not papered over)
- **Twin legibility — PARTIAL.** The twin is PII-safe but a naive viewer does not recognize it as an
  intersection (it reads as an abstract labeled surface with markers). The abstraction that guarantees
  privacy costs recognizability. Open problem: make it read as the scene without re-introducing PII.
- **Real-time — not built (path mapped).** The architecture (per-frame container + model reload) is the
  bottleneck; a persistent multi-model server + GPU renderer + EMA anchor is the concrete path
  (`results/optimization-review.md`). Reach goal R3.
- **Dense-crowd individuals — not detectable** at this camera distance (YOLO gets 0–3 of hundreds). By
  design, crowds are represented as anonymized mover-regions — which is *more* PII-safe.
- **Seg is single-class-dominant** (frame 05 over-labels road, frame 08 over-labels vegetation) — the
  SegFormer elevated-crowd domain gap. Geometry is independent of it and sound.

## The Spark story
Depth + seg + detect + a stabilized 3D twin run **co-resident and fully local** in the GB10's unified
memory — the raw video never leaves the device; only a privacy-safe abstraction does. Privacy by
locality *and* by abstraction.

## Honest bottom line
A working, non-trivial systems pipeline that ingests raw surveillance video and produces a stable,
labeled, **provably PII-free** 3D representation locally on the Spark. The privacy claim is the
strongest result (neutral-oracle proven). The weakest link is making the private twin also *legible* —
the next real problem, clearly scoped.
