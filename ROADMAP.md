<!-- Concern: the phased plan, goals, and gate criteria for the privacy-preserving digital-twin experiment | Non-concern: repo mechanics (README), coding standards (KB), or the neutral-reviewer wording once frozen (docs/) | IO: none -->

# Privacy-Preserving Real-Time Digital Twin — Roadmap

## The bet

Turn a **static CCTV feed** into a **continuous, temporally-stable, semantically-labeled 3D
representation** that a neutral observer recognizes as the same scene — carrying **zero PII** (no
faces, no raw pixels) — running **fully local on the DGX Spark (GB10)**. The pitch: surveillance you
could legally run in a hospital, school, or workplace, because only labeled geometry ever leaves the
sensor's edge.

The labeled point cloud *is* the privacy firewall — no texture, no faces, just geometry + labels. The
CAD "digital twin" is coherence polish on top of an already-safe representation, which is why it is a
reach goal, not the foundation.

## What proves or kills the bet

The bet is **proven** when a blind reviewer, shown a render of the streaming labeled point cloud and
told nothing, independently describes the intended scene (road, sidewalks, people crossing, vehicles
in plausible 3D layout) that stays stable frame-to-frame for large objects. It is **killed** if the
geometry is too noisy to place anything coherently (Stage B is where that verdict lands — early and
cheap, by design). Everything is judged on surfaced evidence, never a code-emitted PASS/FAIL.

---

## How we work (values → this experiment's disposable rules)

Derived from `~/.knowledge-base/ai-agent-work-standards/agentic-experiment-values.md`. These rules
belong to *this* experiment and are thrown away after it.

- **Ratchet, bottoms-up.** One judgeable unit at a time: unblock → de-risk → unblock. Close each door
  honestly (gaps documented and judged adequate for what it feeds), then build on it. Never build on
  an unclosed door.
- **Refuse premature collapse.** No code emits PASS/FAIL. Artifacts + blind descriptions are surfaced
  and judged holistically. A result that is *too clean* is a reason for suspicion, not celebration.
- **One artifact, one claim.** No 747-cockpit. Each render tests a single thing a blind reviewer can
  read straight off. Prefer several dead-simple artifacts over one compound one.
- **Ground in an oracle you can't bend.** The blind reviewer (below) is that oracle. Its independence
  is the whole point — never lead it, never grade your own render with it.
- **Ideal → real, no skipped rungs.** Prove the single clean frame before the stream; characterize
  noise *per component*, in understand-mode, before any countermeasure. "How does the whole pipeline
  handle noise?" answers nothing.
- **Keep raw state rich.** Commit the frames, depth maps, renders, and blind descriptions as proof
  artifacts. Delete bad *work*, never the learnings or the data.
- **Resumability is the higher bar.** Pushing a unit further means resuming, not restarting.

---

## The gates

Two independent review systems. They judge different things and must not be conflated.

### 1. Blind Semantic Gate — the experiment's unit test

Pass a rendered artifact (mask overlay, depth map, point-cloud side/overlay view, later the twin) to
a **neutral reviewer that had no hand in producing it and no knowledge of intent**. It describes what
it sees, in detail, unled. If its independent description contains the **pre-registered intent**
(written down *before* the review), the unit advances.

The discipline, not the machinery, is what matters:

- **Frozen prompt** — identical every call, so it cannot encode intent. The full text:

  > You are a neutral image reviewer with no context about this image's origin or purpose. Describe
  > what you see in exhaustive detail: every distinct object or region, where it is in the frame, its
  > apparent orientation and depth/distance, what it appears to be doing, and the spatial relationships
  > between things. If the image looks like a 3D rendering, point cloud, or map, describe its structure
  > and layout as you perceive it. Report only what is visibly present. Do not speculate about the
  > image's purpose, how it was produced, or what it is supposed to be.

- **Blind reviewer** — a fresh vision agent handed *only* the image. Must not be a model that produced
  the artifact (no self-grading). For load-bearing gates, use a panel of 3 and require the intent to
  surface in a majority.
- **Pre-registered intent** — the entities + relations expected, written before the review. Post-hoc
  intent is cheating.
- **Stripped artifact** — no filename hints, captions, legends, or axis titles that leak intent.
- **Holistic verdict** — score recall of the pre-registered elements + flag any contradiction or
  hallucination. The verdict is reasoning, not a boolean; it yields an advance/hold decision.

### 2. Commit Gate — code & prose (repo mechanics, not the experiment)

`git-agent-verdict` at commit time, judging against the KB standards; `annotated-tree` strict + a
comments-never-multiline check at pre-commit. Distinct from the semantic gate. Wiring lives in the
README / `.githooks/` once the plan is approved.

---

## Topology & run environment

- **Author + git + gates: this laptop** (`~/src/hackathon`) — KB rubrics, `annotated-tree`,
  `git-agent-verdict` all resolve here. Source of truth.
- **Execution: DGX Spark** (`gn100` / `acer01`) — the GPU, the models, 128 GB unified memory.
- **Deploy: `rsync`** the working tree laptop → DGX per run (exclude `.git`); results flow back and
  commit here as proof.
- **Run env:** a container derived from `nvcr.io/nvidia/vllm` — its torch reports `cuda=True` on the
  GB10 (Blackwell sm_121), so the hard dependency is already solved. Pip adds `ultralytics`,
  `transformers`, the depth model; weights pull from Hugging Face. No NGC, no host torch.

---

## The spine (ratchet)

Each stage lists its **Goal** (must hold to advance), **Reach goals** (stretch, never blocks the
spine), what we build, the blind-gate criterion, the proof artifact, and the risk it retires.

### Stage A — Single-frame reconstruction

**Goal:** from one frame, produce a colored-by-label 3D point cloud (segmentation ⊕ depth), rendered
from a side view and as an overlay, that a blind reviewer describes as the intended scene.

Sub-units (each independently closeable):

- **A1 — Semantic segmentation.** raw → SegFormer-B0 (Cityscapes) → label mask.
  *Gate:* blind reviewer, shown the mask overlay, names road, sidewalk, building, people, vehicles.
- **A2 — Depth.** raw → Depth-Anything V2 → depth map.
  *Gate:* blind reviewer sees coherent near/far structure (not noise); edges are clean (flying pixels
  at silhouettes culled, so surfaces don't smear).
- **A3 — Lift & render.** overlay(mask, depth) → point cloud colored by label → render side + overlay.
  *Gate:* blind reviewer describes the intended 3D layout (people on walkable regions, vehicles on the
  road band, plausible relative distances).

**Reach goals:**
- Swap Cityscapes → Mapillary Vistas for explicit crosswalk / curb / lane-marking masks.
- YOLOE (open-vocab) fallback for non-COCO objects.
- Shaded render with an explicit ground plane, not raw points.

**Proof:** the three artifacts + their blind descriptions + pre-registered intents.
**Risk retired:** do the perception models see the real scene, and does a single frame lift to a
coherent 3D layout at all.

### Stage B — Two-frame continuity (the delta test)

**Goal:** two frames with sufficient motion → the static background point cloud stays put; a moving
object moves smoothly; large-object labels persist. This is where the bet is most at risk.

Sub-units:

- **B1 — Depth anchor (the crux unit).** Monocular depth is defined only up to scale+shift and is
  re-estimated per frame — the source of temporal "hop." Because the camera is static: identify the
  **static pixels** (temporal median / background subtraction ∩ semantic-static classes), robustly fit
  the affine `depth_metric = a·depth_rel + b` over that whole distribution (never a single or the
  farthest pixel), and **low-pass the two scalars `(a, b)`** across frames. Absolute scale is a fixed
  display convention, not recovered metres.
  *Gate:* blind reviewer sees the **same** background structure in both renders; an overlay diff shows
  the background fixed while the moving object translates.
- **B2 — Detect & track.** YOLO26-seg + ByteTrack → large objects keep identity across the two frames.
  *Gate:* large-object labels do not hop; blind reviewer identifies "the same vehicle" in both frames.

**Reach goals:**
- Light per-object depth EMA.
- Quantify hop rate as a function of object size and crowd density (turns the known limit into a
  measured curve).

**Proof:** paired renders + overlay diff + blind descriptions; a hop-rate number.
**Risk retired:** is monocular depth + the static anchor coherent enough to keep a world stable —
**if B1 fails, the whole approach needs a rethink, which is exactly why it is gated this early.**

### Stage C — Streaming

**Goal:** run A+B as a streaming loop over the clip → a continuous labeled point-cloud stream; static
scene rock-steady; large objects stable; crowds degrade gracefully and *documented*, not papered over.

*Gate:* blind reviewer, shown a short render of the stream, describes a coherent stable scene — not
flickering soup.

**Reach goals:**
- Hit a real-time target on the GB10: **≥10 FPS at 720p, or a 2 s rolling window with <1 s added
  latency** (pick one, measure GPU utilization to prove headroom).
- If short of target: two-box throughput (DGX + 5070 Ti) or keyframe + track-interpolation.

**Proof:** a rendered stream clip + its blind description + an FPS/latency number.
**Risk retired:** the "real-time on live surveillance" claim is earned, not asserted.

### Stage D — Digital twin (REACH — deferred until A–C stand)

**Goal (reach):** swap labeled clusters for generic CAD primitives (car → sedan, person → humanoid),
placed by position + scale + heading on the segmented ground, rendered as a twin.

*Gate:* blind reviewer describes the twin as the intended scene; **plus the killer comparison** — the
same blind reviewer describes the real (blurred) frame and the twin: the twin must **preserve scene
semantics** (activity, layout) while **omitting identity semantics** (no "man in red jacket, ~30")
that the real-frame description carried. One neutral test proves fidelity *and* PII-strip together.

**Reach goals within the reach:**
- EKF pose smoothing; occlusion-persistent track identity.
- Orientation for static / symmetric objects via a category pose net (motion-heading covers moving
  objects; parked/symmetric is the hard residue).
- Audio events via Nemotron Omni (hear + see: "alarm audible while crowd disperses").

---

## Component units (the closeable doors)

Built and closed in dependency order; each is resumable on its own.

1. **Frame source** — clip → frames (later: live stream ingest).
2. **Semantic segmentation** — SegFormer-B0 (Cityscapes).
3. **Depth + static anchor** — Depth-Anything V2 + static-pixel affine fit + `(a,b)` low-pass + edge
   cleanup. *The load-bearing unit; owns temporal stability.*
4. **Detect & track** — YOLO26-seg + ByteTrack.
5. **Lift & render** — point cloud from mask ⊕ depth; 3D viewer (side + overlay).
6. **Neutral-reviewer skill** — the blind semantic gate (a prompt, not a subsystem).
7. **CAD swap & twin render** *(reach)* — primitive library, placement, twin renderer.

---

## Goals ledger

**Primary goals (prove the bet):**
- G1. Single frame → coherent labeled 3D point cloud a blind reviewer recognizes (Stage A).
- G2. Static background holds still across frames via the depth anchor (Stage B / B1).
- G3. Large-object labels persist across frames without hopping (Stage B / B2).
- G4. A continuous labeled point-cloud *stream* a blind reviewer reads as one stable scene (Stage C).
- G5. Demonstrated PII-safety: the labeled representation carries no faces / raw pixels by construction.

**Reach goals (stretch, none blocks the spine):**
- R1. Crosswalk / curb detail via Mapillary; open-vocab objects via YOLOE.
- R2. Measured hop-rate vs object-size / crowd-density curve.
- R3. Real-time target on the GB10 (≥10 FPS or <1 s rolling window), GPU-util proven.
- R4. Multi-box or keyframe-interpolated throughput if single-GB10 is short.
- R5. CAD digital twin — primitives placed by pose on the segmented ground (Stage D).
- R6. The killer real-vs-twin blind comparison: semantics preserved, identity stripped.
- R7. Audio-aware events via Nemotron Omni.
- R8. Orientation for static / symmetric objects (category pose net).
- R9. Moving-camera / multi-camera support (drops the static-anchor assumption).

---

## Known limits (documented, not hidden)

- **Monocular depth is not metric** — scale is a display convention; the twin needs only relative
  geometry.
- **Dense crowds cause ID switches** — label stability is a curve in object-size and density, holding
  for large objects and degrading for occluded pedestrian crowds. Measured, not eliminated (R2).
- **Static-camera assumption** underpins the depth anchor (B1). Moving cameras are R9, not the spine.

---

## Open decisions (to lock before build)

- **Commit-gate shape:** experiment gate advisory vs blocking; ban all docstrings vs allow framework
  ones; scope the testing gate to reusable `lib/` and leave `experiments/` ungated. (Proposed
  defaults: advisory, ban docstrings, scope to `lib/`.)
- **Segmentation ontology:** start Cityscapes; switch to Mapillary only if crosswalk detail earns the
  story (R1).
- **Real-time target:** ≥10 FPS vs 2 s rolling window (R3).
- **Blind-gate reviewer:** single vs 3-panel on load-bearing gates.
