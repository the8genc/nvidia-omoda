# OMODA: Orchestrated Multi-model Operator with Delegated Autonomy

**Agent Capability PRD**

**Author:** Arif Gursel (ag@getonpace.org) · 8genC
**Date:** 2026-08-15
**Status:** Draft, pre-build (hackathon build window opens Fri 2026-08-14 evening)
**Slug:** `omoda`
**Repo:** [`the8genc/nvidia-omoda`](https://github.com/the8genc/nvidia-omoda)
**Sibling project (shares the box):** [`the8genc/leftovers`](https://github.com/the8genc/leftovers)
**Event:** NVIDIA Spark Hackathon, Seattle · **Track: DO (Agentic AI)** · targeting the **NeMoClaw + OpenShell bounty** and the **Nemotron Lightning bounty**

---

## 1. Capability Overview

### The one-sentence thesis

> **Human-gating every dangerous action is a workaround for the absence of enforced containment. NVIDIA OpenShell supplies the enforcement, so OMODA moves the human gate off the *action* and onto the *envelope*.**

### What this system does

OMODA is a **multi-agent operator** that lives inside an NVIDIA **OpenShell** sandbox on an Acer Veriton GN100 (DGX Spark, `gn100-390c`), managed by **NVIDIA NemoClaw**. A **HERMES** agent harness is the single human-facing surface, reachable over **Telegram**. Behind HERMES sits a small team of specialized sub-agents running on **three different models**, and beneath all of them sits the component that makes the project interesting: the **Autonomy Broker**.

The Broker is the choke point through which every dangerous action passes: shell execution, filesystem writes, package installs, git operations, network egress, outbound messages. In a conventional agent deployment (including our own prior art, §3), each of these is stopped and texted to a human for a `YES`. OMODA does not do that. Instead the Broker classifies each action against a **machine-checkable autonomy envelope** derived from the *live OpenShell policy*, and:

- **Executes autonomously** anything provably contained by that envelope: no human, no prompt, full speed.
- **Executes, then reports with a one-tap `UNDO`**, anything irreversible but still inside the envelope.
- **Escalates to Telegram only when an action would cross the envelope boundary**; what the human approves is not the action, it is a **signed policy delta** (`openshell policy update --add-endpoint …`). Approve once; the capability is now inside the envelope and every subsequent use of it is autonomous.
- **Refuses unconditionally**, with no human override path, anything on the prohibited list (§9.4), including everything belonging to the *other* team sharing the box.

The inversion matters because OpenShell's containment is not a prompt instruction the model can talk its way around. It is **Landlock LSM filesystem confinement, deny-by-default L7 network policy, dropped Linux capabilities, and gateway-side credential brokering in which the agent never holds an API key at all**. The blast radius is enforced below the model. That is what earns the agent the right to act without asking.

### Agent type

**Long-running, interactive + autonomous hybrid, multi-agent.** HERMES is an always-on sandboxed agent with a Telegram transport; sub-agents are spawned per task by the orchestrator; the Broker and Ledger are always-on services. Single-operator (one principal) for v1; the design is per-operator cloneable.

### Target users

- **Primary: the on-call operator/builder** (hackathon: the OMODA team; after: a solo engineer or small platform team) who wants an agent that actually *does* long-running system work overnight rather than accumulating a queue of approval texts.
- **Secondary: the security/platform reviewer** who must be able to answer "what did it do, under what authority, and can we undo it?" from an audit ledger rather than from chat scrollback.
- **Tertiary: hackathon judges**, who per the rules weigh *systems engineering, technical execution, and integration with NVIDIA technology* over concept decks and API wrappers.

---

## 2. Problem Statement

Autonomous agents today are stuck between two failure modes, and neither is acceptable for real system work.

**Failure mode 1: the approval treadmill.** The safe pattern is to gate every irreversible action on explicit human approval. It works, and it is what responsible systems do today. But it caps the agent's value at the human's response latency. An agent that must text before every `rm`, every `git push`, every `pip install` cannot run a four-hour build, cannot triage an incident at 3am, and cannot do the "long-running workflows orchestrated across multiple tools" the Agentic track asks for. The human becomes the bottleneck they were trying to remove, and, worse, **approval fatigue sets in**: after the fortieth `YES` the human is rubber-stamping, so the gate is now theater.

**Failure mode 2: trust by prompt.** The alternative is to let the agent run and *instruct* it not to do dangerous things. This is containment as a suggestion. A system prompt is not a security boundary; it does not survive a jailbreak, a confused tool call, a poisoned web page, or a model that simply misreads its situation. The agent holds real credentials and has real reach, and the only thing between it and the blast radius is text.

**What is missing is the third option:** an agent whose blast radius is *enforced by the runtime and provable to a reviewer*, so that autonomy inside that radius is safe **by construction** rather than by promise, and whose human interaction is reserved for the genuinely rare event of *expanding the radius*.

NVIDIA has now shipped the missing piece. **OpenShell** enforces filesystem, network, process, and credential boundaries below the agent, with a declarative, inspectable, hot-reloadable policy. **NemoClaw** makes that runtime operable: lifecycle, blueprints, routed inference, policy presets. Nobody has yet built the layer that *exploits* that guarantee: a broker that reads the live policy as a formal autonomy contract and spends it aggressively.

OMODA is that layer. The bet: **with containment enforced below the model, the right number of approvals for a night of autonomous work isn't forty, and it isn't zero. It's the number of times the agent needed a capability it didn't already have.** For our benchmark, that should be 0–3.

---

## 3. Prior Art & Why This Is Different

OMODA is deliberately the inverse of our own shipped system, and we cite it as the control condition.

**[`agents.getonpace.org`](https://agents.getonpace.org) / [`the8genc/chief-of-staff`](https://github.com/the8genc/chief-of-staff)** is a production multi-agent back-office: an **L0 orchestrator** (GarV) as sole human entry point, a **proxy layer** carrying three cross-cutting faculties (Knowledge/RAG, The Elder, Analyst), **L1 domain agents** (Finance, People-Ops, Marketing, Capital Planning, Secretary, Project Manager, Office Manager), and **L2 worker agents** that operate specific platform APIs. Memory is ZeroDB/ZeroMemory. Its governing invariant is absolute:

> *"no email is ever sent without a valid, unexpired, principal-issued approval token"*, enforced at a single service-layer choke point (`sendGate.js`) and proven by a negative test.

We keep three things from it and invert one.

| Element | chief-of-staff | OMODA | Why |
|---|---|---|---|
| **Topology** | L0 orchestrator → proxy → L1 domain → L2 workers | **Kept.** HERMES (L0) → Broker/Ledger (proxy) → L1 sub-agents → L2 tools | Proven shape; the proxy is the natural home for a policy broker |
| **Single choke point for danger** | `sendGate.js`, one function, all sends | **Kept and generalized.** The Broker is the only path to any dangerous action | The invariant that made the first system auditable |
| **Durable memory / audit** | ZeroDB tables + ZeroMemory recall + Sequential Thinking plans | **Kept.** Same services, plus a local-first WAL for offline resilience (§8) | Reuse; and the box is tailnet-only, so offline-first is mandatory |
| **Gate placement** | **Per action.** Every send waits for a human `YES` | **Per envelope.** Actions inside a runtime-enforced envelope execute unattended; the human approves *envelope changes* | chief-of-staff had no enforced containment, so per-action gating was the only sound choice. OpenShell removes that constraint |

chief-of-staff proved we can build the safe-but-slow version. OMODA asks what containment actually buys, and answers with a number: approvals per unit of work. Measured, in §4.

**Also referenced:** NVIDIA's [Hermes + NemoClaw research-agent blueprint](https://developer.nvidia.com/blog/deploy-self-evolving-agents-for-faster-more-secure-research-with-a-hermes-agent-and-nvidia-nemoclaw/) (three-layer Model / Harness / Runtime split, the SKILL.md self-teaching loop, policy-as-YAML egress), which OMODA follows structurally and extends with the Broker, the multi-model routing tier, and the Telegram operator channel.

---

## 4. Goals & Success Metrics

The headline metric is deliberately adversarial to our own thesis: if delegated autonomy does not collapse the approval count *while holding containment violations at zero*, the project failed.

| # | Goal | Metric | Target | How measured |
|---|---|---|---|---|
| G1 | **Autonomy actually pays off** | Human approvals required per completed benchmark task (§16.4), vs. a per-action-gated control run of the same task | **≥ 10× reduction** (control ≈ 30–50 → OMODA ≤ 3) | Ledger count, both modes, same task |
| G2 | **Containment is never violated** | Actions executed outside the live OpenShell policy envelope | **0** (hard invariant) | Ledger vs. `nemoclaw omoda policy list` diff, asserted in CI |
| G3 | **Nothing prohibited, ever** | T3-classified actions executed | **0**, with no human override path existing in code | Negative tests (§16.1) |
| G4 | **The shared box survives** | Sibling-project (`leftovers`) outages caused by OMODA; OOM kills of the shared vLLM | **0** | `spark-status.sh` sampling + incident log |
| G5 | **Escalations are legible** | Telegram escalations that state the exact policy delta and the requesting agent, tool, and reason | **100%** | Message-schema assertion |
| G6 | **Irreversible actions are recoverable** | T1 actions with a working compensating action registered before execution | **100%** | Broker refuses T1 without a registered inverse |
| G7 | **Multi-model is real, not decorative** | Distinct models carrying distinct, load-bearing roles | **≥ 3**, each with a measured share of calls | Ledger `model` field, per-role breakdown |
| G8 | **Audit completeness** | Dangerous actions with a complete ledger record (actor, tool, args-hash, tier, authority, outcome, model, trace) | **100%** | Schema validation over the ledger |
| G9 | **Operator latency** | Median Telegram round-trip: escalation sent → policy applied → action retried | **< 60 s** | Ledger timestamps |
| G10 | **Test quality** | Coverage on the Broker + Ledger service layer | **≥ 80%** | `npm run test:coverage` |
| G11 | **Rules compliance** | Third-party dependencies failing the >2-week open-source rule | **0** | `scripts/compliance-check.mjs` in CI (§14) |

---

## 5. User Stories

> Given / When / Then acceptance criteria. "Operator" = the human on Telegram.

### US-1: Delegate a long-running job and walk away
**As an** operator, **I want** to hand OMODA a multi-hour system task over Telegram **so that** it makes progress while I sleep instead of queuing approvals.

- **Given** the OMODA sandbox is running with a finalized autonomy envelope,
- **When** I send HERMES a task over Telegram (e.g. *"port the `leftovers` frame sampler to the Omni endpoint, get its tests green, open a PR on a branch"*),
- **Then** HERMES plans on Nemotron 3.5 Lightning, dispatches sub-agents, executes every T0/T1 action unattended, and I receive **only** a start acknowledgement, T1 notices with `UNDO`, T2 escalations if any, and a final summary, with the full action list recorded in the ledger.

### US-2: T0 contained action runs with no human at all
**As an** operator, **I want** provably-contained actions to just happen **so that** the agent is not throttled by me.

- **Given** an action whose effects are confined to the sandbox workspace and reachable only via already-allowed endpoints (e.g. `pytest`, reading a repo file, an `npm` install covered by the `npm` preset),
- **When** the sub-agent requests it through the Broker,
- **Then** the Broker classifies it **T0**, executes immediately, writes a ledger entry, and **sends no Telegram message**.

### US-3: T1 irreversible-but-contained action, act first then offer UNDO
**As an** operator, **I want** irreversible actions inside the envelope to proceed while remaining recoverable **so that** I get speed without losing the ability to walk it back.

- **Given** an irreversible action inside the envelope (deleting a workspace file, force-updating a local branch, `git push` to an OMODA-owned branch),
- **When** the Broker classifies it **T1**,
- **Then** it **first registers a compensating action** (content snapshot to the ledger, prior ref, remote ref), refusing to proceed if no inverse can be registered (G6), executes, and sends one Telegram notice with an inline `UNDO <token>` valid for the TTL (default 30 min).

### US-4: UNDO actually reverses it
**As an** operator, **I want** `UNDO` to work **so that** T1 autonomy is a real safety trade, not a comforting label.

- **Given** a T1 action with an unexpired `UNDO <token>`,
- **When** I tap it in Telegram,
- **Then** the Broker replays the registered compensating action, verifies the restored state matches the pre-action snapshot hash, replies with the verified result, and records the reversal; a second use of the same token is refused as spent.

### US-5: T2 boundary crossing, approve the *capability* not the action
**As an** operator, **I want** to approve a policy change once rather than an action forty times **so that** each approval buys durable capability.

- **Given** a sub-agent attempts egress to a host absent from the OpenShell policy (say `api.github.com`),
- **When** OpenShell denies the connection and the Broker intercepts the denial,
- **Then** I receive a Telegram message stating the requesting **agent, tool, reason, host:port, and the exact proposed policy delta** (methods, paths, binaries, TLS, enforcement) plus `APPROVE <token>` / `DENY <token>`,
- **And** on `APPROVE` the Broker applies the delta via `openshell policy update`, confirms it in `policy list`, retries the original action, and **every later call to that host runs autonomously as T0/T1**.

### US-6: Denial is durable and cheap
**As an** operator, **I want** a `DENY` to stick **so that** the agent does not re-ask.

- **Given** a T2 escalation,
- **When** I reply `DENY <token>`,
- **Then** the Broker records the denial, returns a structured refusal to the requesting agent, adds the target to a session denylist, and **suppresses re-escalation** for the same host+reason for the remainder of the session (reported once in the summary).

### US-7: Prohibited actions have no approval path
**As an** operator, **I want** certain actions to be impossible **so that** neither the agent nor a tired me can take down the shared box.

- **Given** any action touching the prohibited list (§9.4): the shared vLLM on `:8000`, the sibling team's port block, the host Docker socket, `$HF_HOME`, credential exfiltration, or a policy delta that would disable the gateway's credential brokering,
- **When** it is requested by any agent, through any path, with any token,
- **Then** the Broker classifies it **T3**, refuses, alerts on Telegram as an **incident** (not an approval request), and **no code path exists** that can execute it, proven by a negative test (§16.1).

### US-8: Multimodal perception without the data leaving the box
**As an** operator, **I want** screenshots, logs, and video handled locally **so that** sensitive artifacts never reach a hosted endpoint.

- **Given** a task requiring perception (read a failing screenshot, summarize a video frame set, parse a scanned doc),
- **When** the Perceiver sub-agent handles it,
- **Then** inference runs against the **local Nemotron 3 Nano Omni** vLLM endpoint only, the ledger records `model=nemotron-3-nano-omni` with `egress=none`, and the Broker **refuses** to route that payload to a hosted model even if the planner requests it.

### US-9: The agent teaches itself, and the lesson survives a rebuild
**As an** operator, **I want** to correct OMODA once **so that** it holds after the sandbox is rebuilt.

- **Given** I correct HERMES over Telegram (*"always run the linter before you open a PR"*) and tell it to remember,
- **When** HERMES writes the pattern as a `SKILL.md` in its skills directory,
- **Then** OMODA promotes it to ZeroMemory as a **skill candidate** with provenance, and after `nemoclaw omoda rebuild` the skill is restored and demonstrably applied on the next matching task.

### US-10: Ask what it did
**As an** operator, **I want** to interrogate the audit trail from my phone **so that** I can review without SSH.

- **Given** a completed session,
- **When** I send `AUDIT last 2h` or `AUDIT tier:T1`,
- **Then** HERMES queries the ledger and returns a compact chronological list: timestamp, agent, tool, tier, authority (`envelope` / `operator:<token>` / `denied`), outcome, model, with a link to the full JSONL.

### US-11: Kill switch
**As an** operator, **I want** to stop everything instantly **so that** I am never dependent on the agent behaving in order to stop it.

- **Given** OMODA is mid-task,
- **When** I send `HALT`,
- **Then** the Broker enters `refuse-all` within 2 s (in-flight actions are allowed to finish but no new one is admitted), sub-agents are cancelled, the state is recorded, and only an explicit `RESUME` re-admits actions; `HALT` is honored even if the Telegram channel is the only surviving component.

### US-12: The sibling project is never collateral damage
**As an** operator on a shared box, **I want** OMODA to be structurally incapable of harming `leftovers` **so that** two teams can share one GN100.

- **Given** OMODA is running alongside the `leftovers` CV workload,
- **When** OMODA allocates any resource: a listening port, memory, a GPU context,
- **Then** it stays inside its assigned 100-port block, refuses to bind outside it, pre-checks free memory against a floor before any memory-hungry step, and aborts with a Telegram notice rather than risking the shared vLLM (G4).

---

## 6. Features

### 6.1 Functional requirements

1. **Telegram operator channel**: bidirectional, the sole human surface. Task submission, T1 notices with `UNDO`, T2 escalations with `APPROVE`/`DENY`, `AUDIT`, `STATUS`, `HALT`/`RESUME`. Bot token is held **by the host**, injected via NemoClaw channel config; the agent never reads it.
2. **HERMES harness (L0)**: the NemoClaw-supported Hermes agent: sessions, skills, memory, bridges, hooks. Interprets the operator, plans, dispatches, reports.
3. **Sub-agent orchestration (L1)**: four role-scoped agents (§9.2): **Builder**, **Operator**, **Scout**, **Perceiver**. Each gets a *narrowed* envelope (a subset of the sandbox policy); no sub-agent inherits HERMES' full reach.
4. **Autonomy Broker**: the single choke point. Classifies every dangerous action T0–T3 against the live policy, enforces compensating-action registration for T1, converts OpenShell denials into T2 escalations, applies approved policy deltas, and refuses T3.
5. **Envelope compiler**: reads live OpenShell/NemoClaw policy (`nemoclaw omoda policy list`, `policy get`) plus the Landlock mount config, and compiles a machine-checkable envelope the Broker evaluates against. **Re-read after every policy change**; the envelope is never a hardcoded copy.
6. **Action Ledger**: append-only, hash-chained JSONL local WAL + durable replication to ZeroDB. Every dangerous action: actor, tool, args hash, tier, authority, model, latency, outcome, compensating-action ref, trace id.
7. **Compensating-action registry**: per-tool inverse implementations (file snapshot/restore, git ref save/reset, branch delete, message retract-or-correct). T1 without a registered inverse is refused, not downgraded.
8. **Multi-model routing**: three models, three roles (§7), routed by task class and data sensitivity, with a hard rule that locally-classified-sensitive payloads never leave the box (US-8).
9. **Self-authored skills + promotion**: HERMES writes `SKILL.md`; OMODA promotes to ZeroMemory skill candidates with provenance and restores them post-rebuild.
10. **Cross-session memory**: ZeroMemory `remember`/`recall`/`reflect`/`profile`/`relate` for operator preferences, prior decisions ("operator always denies egress to X"), and the Context Graph linking tasks ↔ actions ↔ approvals.
11. **Decision traces**: each task persisted as a Sequential Thinking plan artifact (`plan/create` → `plan/update`), giving a replayable "why did it do that".
12. **Shared-box guard**: port-block enforcement, memory floor pre-checks, `spark-status.sh` gating before heavy steps, bounded concurrency against the shared vLLM.
13. **Observability**: OpenTelemetry traces via the NemoClaw `observability-otlp-local` preset (already present on the box); Broker decisions and model calls as spans.

### 6.2 Non-functional requirements

- **Safety (paramount).** G2/G3 are invariants enforced in the service layer and proven by negative tests, not conventions. The Broker fails **closed**: any classification error, policy-read failure, or ledger-write failure refuses the action.
- **Offline-first.** The box is tailnet-only and OpenShell is deny-by-default. Every core loop (plan → act → ledger → Telegram) must work with the **local model and local WAL alone**. ZeroDB/ZeroMemory sync and hosted Lightning inference are enhancements that degrade gracefully, never hard dependencies. *(We hit AINative outages mid-build on chief-of-staff. Assume it happens again.)*
- **Resource discipline.** The box has **121 GiB unified CPU+GPU memory with ~115 GiB already in use**. OMODA **must not load a model**. It is a client of the already-running vLLM instance and of hosted inference. Hard floor: abort any step that would take free memory below 4 GiB.
- **Latency.** Broker classification < 50 ms p95 for static rules; < 1.5 s when the Omni risk-classifier is consulted. Telegram escalation → policy applied → retry: < 60 s median.
- **Security.** No credential ever enters the sandbox: NVIDIA inference and Telegram are brokered by the OpenShell gateway. Approval tokens are short, single-use, time-boxed, bound to a specific action or policy delta, and honored only from the registered operator chat ID.
- **Auditability.** The ledger is hash-chained; tampering is detectable. Every entry names the authority under which the action ran.
- **Testability.** ≥ 80% coverage on Broker + Ledger, TDD, with the T3 and envelope-violation negative tests written **first**.

---

## 7. The System of Models

The hackathon material is explicit that the intended pattern is *a system of small specialized models rather than one large general model*. OMODA uses three, and each earns its place on a real constraint.

| Role | Model | Where | Why this model, here |
|---|---|---|---|
| **Planner / tool-caller** (HERMES brain) | `nvidia/nemotron-3.5-lightning-30b-a3b` | **Hosted**, at `https://integrate.api.nvidia.com/v1`, **routed through the OpenShell gateway** | Purpose-built for agent harnesses: leading agentic accuracy on tool calling, instruction following, and multi-turn workflows at high token throughput. Also the **Lightning bounty** requirement. Hosted because the box has ~6 GiB free; a second 30B model physically cannot load. The gateway holds the key; the agent never sees it. |
| **Perception + risk classification** | `nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-NVFP4` | **Local**, vLLM on `:8000` (already running, shared) | Native text+image+video+audio in one model, so screenshots/logs/video need no separate VLM. Critically: it is **on-box**, so sensitive artifacts are classified and read **with zero egress** (US-8), which is the real reason it stays local. Doubles as the Broker's semantic risk classifier for actions static rules can't settle. |
| **In-sandbox guard / router** | Small local model (≤ 3B, NVFP4), **memory-gated** | Local, in-sandbox | Cheap first-pass intent routing and prompt-injection screening on untrusted fetched content, kept off the shared vLLM queue. **Explicitly conditional:** loads only if free memory ≥ 6 GiB at boot (§13). Otherwise this role folds into the Omni endpoint and the ledger records the fallback. Better to ship two we actually ran than claim three we couldn't fit. |

**Routing rules (enforced in the Broker, not the prompt):**
1. Payload classified sensitive (contains repo secrets, local paths, screenshots of the box, operator PII) → **local only**. A hosted route for such a payload is refused and logged.
2. Multimodal input → Omni, always.
3. Planning, tool selection, multi-turn task decomposition → Lightning, when egress is available; **falls back to Omni** with a recorded quality caveat when it is not.
4. Untrusted external content is screened by the guard model **before** it reaches the planner's context.

---

## 8. Memory & Data Strategy

Two hard constraints collide: the AINative architecture rule that **ZeroDB/ZeroMemory is the mandatory memory and context layer, and no third-party memory services, hosted vector databases, or generic memory MCPs of any kind**, and the operational reality that the box is **tailnet-only behind a deny-by-default egress policy** and the demo must survive with no internet at all.

**Resolution: local WAL, durable ZeroDB, one source of truth.**

- **Local write-ahead ledger** (`~/omoda/var/ledger/*.jsonl`, append-only, hash-chained) is the **durability mechanism**, not a competing database. Every Broker decision is fsynced here before the action executes. It exists so that a network partition can never cause an unlogged dangerous action.
- **ZeroDB is the system of record.** A syncer drains the WAL into ZeroDB NoSQL tables (`omoda_actions`, `omoda_approvals`) and vectors, at-least-once with idempotency on `action_id`. Entries carry `synced_at`; the ledger reports its own sync lag.
- **ZeroMemory is the cognition layer**: `remember`/`recall`/`reflect` for operator preferences and prior decisions, `profile` for the operator entity, `relate` for the Context Graph (task ↔ action ↔ approval ↔ skill), **skill candidates** for promoted `SKILL.md` files, and **decision traces**. These are first-class ZeroMemory features and map to this use case without adaptation.
- **Sequential Thinking** persists each task's reasoning chain as a plan artifact (`plan/create`/`plan/update`) so any action in the ledger can be traced back to the reasoning that produced it.
- **Egress:** reaching AINative requires an explicit policy entry. That entry is itself proposed through the normal T2 flow. **OMODA's own cloud dependency is approved by the operator through OMODA's own escalation mechanism.** If never approved, the system runs fully local and the demo still works.

No third-party memory or database service appears anywhere in this design.

---

## 9. Technical Architecture

### 9.1 Deployment topology

```
┌─ Acer Veriton GN100 · gn100-390c · GB10 · aarch64 · 121 GiB unified ─────────────┐
│                                                                                   │
│  HOST                                                                             │
│   ├─ vLLM (:8000)  nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-NVFP4  [SHARED]  │
│   ├─ NemoClaw CLI v0.0.90  ·  OpenShell driver: docker                            │
│   ├─ OpenShell gateway (:8080)  ── holds ALL credentials ──┐                      │
│   └─ Telegram bot token (host-side, injected as channel)   │                      │
│                                                            │                      │
│  ┌─ OpenShell sandbox "omoda" ────────────────────────────┼────────────────────┐ │
│  │   Landlock FS confinement · caps dropped · deny-by-default L7 egress         │ │
│  │                                                        │                     │ │
│  │   ┌──────────────────────────────────────────────┐    │                     │ │
│  │   │  L0  HERMES harness (skills/sessions/memory) │◀───┼── Telegram ◀──▶ Operator
│  │   │      plans on Nemotron 3.5 Lightning         │    │   (via gateway)     │ │
│  │   └───────────────────┬──────────────────────────┘    │                     │ │
│  │                       │ dispatch                       │                     │ │
│  │   ┌───────────────────▼──────────────────────────┐    │                     │ │
│  │   │  L1  Builder · Operator · Scout · Perceiver  │    │                     │ │
│  │   │      (each = narrowed sub-envelope)          │    │                     │ │
│  │   └───────────────────┬──────────────────────────┘    │                     │ │
│  │                       │ EVERY dangerous action        │                     │ │
│  │   ╔═══════════════════▼══════════════════════════╗    │                     │ │
│  │   ║        AUTONOMY BROKER  (choke point)        ║    │                     │ │
│  │   ║  envelope compiler ← live OpenShell policy   ║    │                     │ │
│  │   ║  T0 exec │ T1 exec+UNDO │ T2 escalate │ T3 ✗ ║    │                     │ │
│  │   ╚════╦═══════════════╦═════════════════╦═══════╝    │                     │ │
│  │        │ exec          │ ledger          │ escalate    │                     │ │
│  │   ┌────▼─────┐   ┌─────▼──────┐          └─── Telegram ┤                     │ │
│  │   │ L2 tools │   │ Action     │                        │                     │ │
│  │   │ shell/fs │   │ Ledger WAL │──sync──▶ ZeroDB ───────┤ (egress via         │ │
│  │   │ git/http │   │ hash-chain │         ZeroMemory     │  gateway, T2-gated) │ │
│  │   └──────────┘   └────────────┘         Seq. Thinking  │                     │ │
│  └────────────────────────────────────────────────────────┼─────────────────────┘ │
│                                                            │                       │
│   integrate.api.nvidia.com (Lightning) ◀───────────────────┘  key never in sandbox │
└───────────────────────────────────────────────────────────────────────────────────┘
```

### 9.2 Sub-agents and their narrowed envelopes

No sub-agent inherits HERMES' full reach. Least privilege is applied per role, and the Broker enforces the narrowing.

| Agent | Owns | Envelope subset | Typical tier |
|---|---|---|---|
| **Builder** | code, tests, PRs | workspace FS read/write, `npm`/`pypi` presets, git on OMODA-owned branches only | T0 (build/test), T1 (push, delete) |
| **Operator** | processes, system state, diagnostics | shell in workspace, read-only `/proc`, `spark-status.sh`, own port block only | T0 (read/diagnose), T1 (restart own service), **T3** on anything shared |
| **Scout** | research, external reads | HTTP GET to allowed hosts; **no FS write outside a scratch dir**; all fetched content screened by the guard model | T0 in-policy, T2 on any new host |
| **Perceiver** | screenshots, logs, video, audio | read-only FS; **local Omni endpoint only, egress denied at policy level** | T0 |

### 9.3 The Autonomy Broker: classification

The Broker is the only component permitted to invoke a dangerous tool. Classification is deterministic-first; the model is consulted only when static rules are inconclusive, and a model that cannot decide yields **escalation, never execution**.

```
                       ┌──────────────────────────┐
  action request ─────▶│ 1. T3 prohibited list?   │──yes──▶ REFUSE + incident alert
                       └────────────┬─────────────┘         (no override path)
                                    │ no
                       ┌────────────▼─────────────┐
                       │ 2. Inside live envelope? │──no───▶ T2  escalate policy delta
                       │    (FS ∧ net ∧ binary ∧  │         └─ APPROVE → apply → retry
                       │     port ∧ sub-envelope) │            DENY    → refuse + denylist
                       └────────────┬─────────────┘
                                    │ yes
                       ┌────────────▼─────────────┐
                       │ 3. Reversible?           │──yes──▶ T0  execute · ledger · silent
                       │    (static table, then   │
                       │     Omni classifier)     │──no───▶ T1  register inverse ─┬─ ok ──▶ execute
                       └──────────────────────────┘                               │        + UNDO notice
                                    │ inconclusive                                └─ none ─▶ REFUSE
                                    └──────────────────────────────────▶ T2 escalate
```

**Fail-closed guarantees.** Envelope read fails → refuse all. Ledger write fails → refuse. Classifier times out → escalate. Broker crash → sub-agents have no alternate path to tools; work stops rather than proceeding ungoverned.

### 9.4 T3: the prohibited list (no approval path exists)

These are compiled into the Broker as a deny list checked **before** the envelope, and are unreachable by any token:

1. Anything touching the **shared vLLM** on `:8000` (stop, restart, reconfigure, OOM-risking allocation).
2. Any **port outside OMODA's assigned 100-port block**, especially the sibling project's block (G4, US-12).
3. The **host Docker socket**, host `systemd`, or any container other than OMODA's own.
4. `$HF_HOME` (the shared 43 GB model cache): no writes, no deletes.
5. **Credential exfiltration**: reading gateway config, env dumps to network, or any attempt to obtain the Telegram/NVIDIA keys.
6. **Policy deltas that weaken enforcement**: disabling `managed_inference`, adding an inference-provider host directly to the network policy (which would bypass credential brokering), disabling gateway device auth, or applying the `personal-open-internet` preset.
7. Destructive git on shared refs: force-push to `main`, branch deletion on any non-OMODA branch, history rewrite.
8. Any write outside the Landlock-permitted workspace.

Item 6 is the one to watch. Call it the **self-protection clause**. The Broker's authority derives from OpenShell policy, so the Broker refuses to broker changes that would dismantle OpenShell. Without it, T2 is a privilege-escalation ladder; the agent could propose "just add the inference host directly", get a tired `YES`, and thereafter hold a real credential. This is the single most important rule in the system.

### 9.5 Layering (service-layer pattern)

- **Handlers**: Telegram webhook/poller, MCP tool entrypoints. Validate input (`zod`), call the service layer, return. **No business logic.**
- **Service layer**: the Broker (classification, envelope evaluation, escalation, policy application), the Ledger, the compensating-action registry, model routing, the orchestrator. **The only layer that may invoke a dangerous tool.**
- **Adapters**: OpenShell/NemoClaw CLI wrapper, Telegram client, vLLM/NVIDIA inference clients, ZeroDB/ZeroMemory HTTP clients. Interfaces + stubs, each self-disabling if unconfigured.

> **Language:** Node.js (ESM, ≥ 20.6), matching the chief-of-staff stack for reuse velocity and the NemoClaw CLI's own ecosystem. The AINative architecture rules cite Pydantic/SQLAlchemy; those are *platform-backend* conventions; OMODA is a **client** of those APIs, so the equivalents are `zod` for validation and the ZeroDB HTTP client for persistence. Tests: built-in `node:test`.

### 9.6 Concrete policy delta (the US-5 demo artifact)

What the operator actually approves: a scoped, least-privilege endpoint, not a blanket allow. Schema below is the **real** NemoClaw preset schema, read off the box (`nemoclaw-blueprint/policies/presets/*.yaml`), not the looser form shown in the published docs:

```yaml
# proposed by Scout, escalated as T2, applied on operator APPROVE
network_policies:
  github_api:
    name: github_api
    endpoints:
      - host: api.github.com
        port: 443
        protocol: rest          # L7 per-request filtering ON. Omitting this
        enforcement: enforce    # degrades the entry to a raw TCP tunnel and
        rules:                  # makes every rule below decorative.
          - allow: { method: GET, path: "/repos/the8genc/**" }
          - allow: { method: GET, path: "/search/code" }
    binaries:
      - { path: /opt/hermes/.venv/bin/python }   # this agent only
```

Note what is *absent*: no `POST`, so the delta grants read-only reach even though the host is a write-capable API. Intra-segment globs (`/bot*/getUpdates`, `/api/v*/applications/*/commands`) are supported and precedented in the shipped presets.

Applied via the `policy get` → merge → `openshell policy set --policy <file> --wait omoda` round-trip (requires OpenShell ≥ 0.0.72; box has 0.0.85), confirmed via `nemoclaw omoda policy list`, then the envelope is recompiled and the original action retried.

A worked, production-ready instance of this pattern, the hardened operator channel, is checked in at [`policies/omoda-telegram.yaml`](../policies/omoda-telegram.yaml).

---

## 10. MCP Server Design

### Server name
`omoda-broker-mcp`: the Broker exposed as MCP tools. Sub-agents reach dangerous capability **only** through this surface; there is no direct tool access.

| Tool | Description | Read-only | Destructive |
|---|---|---|---|
| `plan_task` | Decompose an operator task into a sub-agent plan (Lightning) | Yes | No |
| `classify_action` | Return the tier + rationale for a proposed action without executing | Yes | No |
| `exec_shell` | **Gated:** run a command in the workspace | No | **Yes** |
| `write_file` / `delete_path` | **Gated:** workspace filesystem mutation | No | **Yes** |
| `git_op` | **Gated:** commit / branch / push on OMODA-owned refs | No | **Yes** |
| `http_fetch` | **Gated:** outbound request; triggers T2 on a new host | No | Yes (egress) |
| `send_operator_message` | **Gated:** outbound Telegram to the operator | No | Yes |
| `perceive` | Multimodal read of an image/video/audio/log via local Omni | Yes | No |
| `propose_policy_delta` | Build a scoped policy delta + escalate for approval | No | No |
| `apply_policy_delta` | **Gated:** apply an operator-approved delta | No | **Yes** |
| `undo_action` | Replay a registered compensating action for a T1 entry | No | Yes (reversal) |
| `query_ledger` | Read the action ledger (backs `AUDIT`) | Yes | No |
| `recall` / `remember` | ZeroMemory cross-session context | Mixed | No |
| `promote_skill` | Persist a `SKILL.md` as a ZeroMemory skill candidate | No | No |

> **Design note.** Nine tools are destructive, and *all nine* funnel through one internal `broker.authorize(action)` call, the generalization of chief-of-staff's `sendGate.js`. Coverage of that one function is the coverage of the safety property.

### Representative schemas

```jsonc
// classify_action
{ "input":  { "agent": "builder|operator|scout|perceiver", "tool": "string",
              "args": {}, "reason": "string" },
  "output": { "tier": "T0|T1|T2|T3", "rationale": "string",
              "envelope_refs": ["policy:github_api", "landlock:/workspace"],
              "inverse_available": true, "classifier": "static|omni" } }

// propose_policy_delta  →  the T2 escalation payload
{ "input":  { "action_id": "uuid", "host": "api.github.com", "port": 443,
              "methods": ["GET"], "paths": ["/repos/the8genc/*"],
              "binaries": ["/usr/local/bin/hermes"], "reason": "string" },
  "output": { "approval_id": "uuid", "token": "7K2", "delta_yaml": "string",
              "expires_at": "iso8601", "telegram_message_id": "int" } }

// exec_shell (gated)
{ "input":  { "cmd": "string", "cwd": "string", "action_id": "uuid" },
  "output": { "status": "executed|refused|escalated", "tier": "T0|T1|T2|T3",
              "authority": "envelope|operator:7K2|denied",
              "exit_code": 0, "stdout": "string", "ledger_seq": 4821,
              "undo_token": "string?" } }

// undo_action
{ "input":  { "undo_token": "string" },
  "output": { "status": "reversed|refused", "verified_hash_match": true,
              "reason": "string?" } }
```

---

## 11. AINative Integration

### Services consumed

- **ZeroDB** (`/api/v1/zerodb`): durable system of record for the action ledger and approval records (NoSQL tables), vectors over prior tasks/decisions for semantic recall, event streaming for the action lifecycle, file storage for T1 pre-action snapshots.
- **ZeroMemory** (`/api/v1/public/memory/v2`), cognitive layer: `remember`/`recall`/`reflect` for operator preferences and prior approval decisions, `profile` for the operator entity, `relate` + Context Graph for task ↔ action ↔ approval ↔ skill, **skill candidates** for promoted `SKILL.md`, **decision traces**.
- **Sequential Thinking** (`zerodb-sequential-thinking-mcp`): per-task reasoning chains persisted as ZeroDB plan artifacts, so any ledger entry is traceable to its rationale.
- **Chat Completions API** (`/api/v1/chat/completions`): **optional tertiary fallback only**, if both Lightning and local Omni are unavailable. Not on the primary path; NVIDIA models are the point of the project.
- **Agent Cloud** (`/api/v1/agents`): **explicitly not used for hosting.** The hackathon requires the workload to run on the GN100. Noted here to record the deliberate deviation from the usual AINative deployment target; OpenShell provides the sandboxing and credential vaulting Agent Cloud would otherwise supply.

### Authentication

- **AINative:** API key held **host-side**, injected into the OpenShell gateway. Reaching `api.ainative.studio` requires an approved egress policy entry, obtained through OMODA's own T2 flow.
- **NVIDIA inference:** `integrate.api.nvidia.com` is a **baseline NemoClaw policy endpoint**; the key lives in the gateway and the agent never receives it.
- **Telegram:** bot token host-side via NemoClaw channel config. Only the registered operator chat ID may issue `APPROVE`/`DENY`/`UNDO`/`HALT`; messages from any other chat are logged and ignored.
- **Approval tokens:** short, single-use, time-boxed (default 30 min), bound to one `action_id` or `delta_hash`.

---

## 12. API Endpoints

AINative paths verified against the live catalog (`prd_list_services`, `prd_get_api_catalog`).

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/public/memory/v2/remember` | Operator preferences, prior decisions |
| POST | `/api/v1/public/memory/v2/recall` | Pre-task context and precedent |
| POST | `/api/v1/public/memory/v2/reflect` | Periodic consolidation of operator preferences |
| POST | `/api/v1/public/memory/v2/profile` | Operator entity profile |
| POST | `/api/v1/public/memory/v2/relate` | Context Graph edges (task ↔ action ↔ approval ↔ skill) |
| POST | `/api/v1/public/memory/v2/graphrag` | Graph-grounded recall over the decision history |
| POST | `/api/v1/public/memory/v2/plan/create` | Open a task reasoning chain |
| POST | `/api/v1/public/memory/v2/plan/update` | Advance the chain as actions resolve |
| GET | `/api/v1/public/memory/v2/plan/history` | Replay a task's reasoning for audit |
| POST/GET | `/api/v1/zerodb/...tables/omoda_actions/rows` | Action ledger rows |
| POST/GET | `/api/v1/zerodb/...tables/omoda_approvals/rows` | Approval + policy-delta records |
| POST | `/api/v1/zerodb/...vectors/search` | Semantic search over prior tasks and decisions |
| POST | `/api/v1/zerodb/...events/batch` | Action lifecycle events |
| POST | `/api/v1/chat/completions` | Tertiary inference fallback only |

**External (non-AINative), reached via the OpenShell gateway:**

| Endpoint | Purpose |
|---|---|
| `https://integrate.api.nvidia.com/v1/chat/completions` | Nemotron 3.5 Lightning, the planner |
| `http://host.openshell.internal:8000/v1/chat/completions` | Local Nemotron 3 Nano Omni, for perception + risk classification |
| `https://api.telegram.org/bot<token>/*` | Operator channel (token gateway-held) |
| `nemoclaw` / `openshell` CLI | Policy read + delta application (host-side, brokered) |

---

## 13. Ground Truth: Verified State of the Box

Verified by direct inspection on 2026-08-15 (`ssh acer01@100.71.143.26`). Numbers below are what the box actually reported.

| Item | Verified value | Consequence for OMODA |
|---|---|---|
| Host / arch | `gn100-390c`, `aarch64`, NVIDIA **GB10** | All images must be ARM64 |
| Memory | **121 GiB total, 115 used, ~6 free** (+15 GiB swap) | **OMODA must not load a model** (§6.2). Third model is memory-gated |
| Disk | 3.7 T, 260 G used | Ample for ledger + snapshots |
| Local model | `nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-NVFP4`, vLLM `:8000`, 131 072 ctx | Perception + risk classifier endpoint. **Shared, so bound concurrency** |
| NemoClaw | CLI **v0.0.90**; sandbox base `ghcr.io/nvidia/nemoclaw/sandbox-base:v0.0.90` (pulled ~3 weeks ago) | Comfortably outside the 2-week rule |
| OpenShell | driver `docker`, version **0.0.85** | ⚠️ Docs cite **0.0.72+** for policy round-trip; satisfied |
| Existing sandbox | `my-assistant` runs `agent: openclaw`, model `nvidia/Qwen3.6-35B-A3B-NVFP4`, provider `vllm-local`, tier `balanced`, gateway `:8080`, dashboard `:18790` | OMODA creates a **separate** sandbox; `my-assistant` is left untouched |
| Blueprint presets | `brave, brew, claude-code, github, gmail, huggingface, jira, local-inference, nous-*, npm, observability-otlp-local, openclaw-diagnostics-otel-local, openclaw-pricing, outlook, public-reference, pypi, tavily, weather` | Messaging presets are **deliberately not here** (#1705/#2180, keeps IM egress opt-in) |
| Messaging channels | `telegram, discord, wechat, slack, whatsapp, teams`, per `nemoclaw my-assistant channels` | Telegram available; policy ships in the CLI channel registry, not the blueprint |
| Telegram policy (stock) | `src/lib/messaging/channels/telegram/policy/hermes.yaml`: `api.telegram.org:443`, `protocol: rest`, `enforcement: enforce`, rules `GET/POST /bot*/**` + `GET /file/bot*/**` | Works, but grants the **entire** Bot API → hardened in `policies/omoda-telegram.yaml` (R8) |
| Telegram credential | Provider `{sandboxName}-telegram-bridge`; agent receives only the placeholder `openshell:resolve:env:TELEGRAM_BOT_TOKEN`; `TELEGRAM_ALLOWED_IDS` gates which user IDs may DM the bot | Confirms §11: the token never enters the sandbox. Set `TELEGRAM_ALLOWED_IDS` to the operator's numeric ID |
| Hermes support | `supportedAgents: ["openclaw", "hermes"]`; `agentPolicyKeys: { hermes: ["telegram"] }`; `hermesAuthMethod` in `sandboxes.json` | HERMES is selectable at sandbox creation (R2 resolved) |
| Path globbing | Intra-segment `*` supported: `/bot*/**`, `/api/v*/applications/*/commands` (Discord preset) | `/bot*/sendMessage`-style least-privilege rules are valid |
| Landlock | `compatibility: best_effort` in the baseline policy | Best-effort, not guaranteed. Scope autonomy to what the kernel actually enforces (§17) |
| Ports in use | `:8000` vLLM (shared), `:8080` gateway, `:11000`/`:11002` tailnet, `:18789`/`:18790` dashboards | OMODA stays in its assigned block → R3 |
| Model cache | `$HF_HOME`, 43 GB, shared | **T3: no writes** |

### Risk register

| # | Risk | Evidence | Mitigation | Owner |
|---|---|---|---|---|
| ~~**R1**~~ | ~~No `telegram` policy preset.~~ **RESOLVED 2026-08-15.** Telegram is fully supported in v0.0.90. The preset is not in `nemoclaw-blueprint/policies/presets/` (where we first looked); it ships in the CLI channel registry at `src/lib/messaging/channels/telegram/policy/{hermes,openclaw}.yaml` and is applied by `channels add telegram` + `policy add telegram`. `nemoclaw my-assistant channels` lists telegram; `tiers.yaml` includes it at `personal`; the baseline excludes messaging **by design** (#1705/#2180) so it stays opt-in | Read the shipped YAML + manifest on the box | **No longer a risk.** We ship a *hardened* variant instead, [`policies/omoda-telegram.yaml`](../policies/omoda-telegram.yaml), because the stock preset allows `GET/POST /bot*/**`, i.e. the entire Bot API. See R8 | Lead |
| ~~**R2**~~ | ~~HERMES may not be selectable.~~ **RESOLVED 2026-08-15.** The Telegram channel manifest declares `supportedAgents: ["openclaw", "hermes"]` and ships a Hermes-specific policy and `agentPolicyKeys: { hermes: ["telegram"] }`; `sandboxes.json` carries a `hermesAuthMethod` field | `src/lib/messaging/channels/telegram/manifest.ts` | Select `hermes` at sandbox creation. OpenClaw remains the fallback; the Broker/envelope/ledger/routing are harness-agnostic either way | Lead |
| **R8** | **Stock Telegram preset is over-broad for OMODA.** `POST /bot*/**` permits `setWebhook`, which re-points update delivery to an arbitrary URL. An agent that can call `setWebhook` can **redirect the approval channel and forge its own approvals**, a T3-class escalation (§9.4 item 6) sitting inside what reads as "just messaging" | Stock `telegram/policy/hermes.yaml` | Ship the hardened preset: seven enumerated methods (`getUpdates`, `sendMessage`, `answerCallbackQuery`, `editMessageText`, `editMessageReplyMarkup`, `getMe`), no `setWebhook`/`deleteMessage`/`sendDocument`/`forwardMessage`, no `/file/bot*/**`. Verified by asserting a **403** on a `setWebhook` attempt (§16.1) | Lead |
| **R3** | Port-block collision with `leftovers` | `~/team.conf` and `~/env.sh` not readable on the shared `acer01` account | **Confirm the assigned block before any bind** (blocking, first task Sat AM). Enforce it in code as a T3 rule. | Lead |
| **R4** | Shared-vLLM contention / OOM takes down both projects | 115/121 GiB used | Bounded concurrency (default 2), memory floor pre-check ≥ 4 GiB, `spark-status.sh` before heavy steps, hard T3 on `:8000` | All |
| **R5** | AINative reachability from a tailnet-only, deny-by-default box | Prior art records live AINative degradation | Offline-first by design (§8): local WAL is authoritative for the demo; sync is best-effort | Lead |
| **R6** | Hosted Lightning unreachable during the demo | Egress dependency | Planner falls back to local Omni with a recorded quality caveat; demo script includes the fallback as a **feature** | Lead |
| **R7** | Notion rules page could not be machine-read (JS-rendered; returned no content on two attempts) | Two fetch attempts returned nothing | Rules sourced from the local transcript MD instead; **a human must diff against the Notion page before submission** | Lead |

---

## 14. Hackathon Compliance

The originality rule as recorded: *all code must be written during the event; only open-source code older than two weeks may be used.* We treat that strictly and mechanically.

**Interpretation (the conservative reading):** a third-party dependency is admissible only if (a) its license is OSI-approved, and (b) the **exact version we pin** was publicly published **on or before 2026-08-01** (14 days before 2026-08-15). All OMODA source is written during the build window in a repo whose history is public evidence.

| Dependency | License | Public since | Version pinned | Verdict |
|---|---|---|---|---|
| **NVIDIA NemoClaw** | Apache-2.0 | repo **2026-03-15** | CLI `v0.0.90`, base image `v0.0.90` (on box ~3 wks) | ✅ |
| **NVIDIA OpenShell** | Apache-2.0 | repo **2026-02-24** | `0.0.85` | ✅ |
| **Nemotron 3 Nano Omni** | NVIDIA open model | announced **2026-04-29** | NVFP4 build already on box | ✅ |
| **Nemotron 3.5 Lightning** | Hosted NVIDIA endpoint | GA before event | `nemotron-3.5-lightning-30b-a3b` | ✅ (hosted service, not vendored code) |
| **vLLM** | Apache-2.0 | long-standing | image on box ~4 wks | ✅ |
| `ainative-zerodb-memory-mcp` | MIT | repo **2026-03-01** | **pin `1.2.6` (2026-05-25)**, *not* `1.2.7` (2026-08-01, exactly on the boundary) | ✅ with pin |
| `zerodb-cli` | MIT | npm **2026-03-22** | latest ≤ 2026-08-01 | ✅ |
| `langchain-zerodb` | MIT | PyPI, pre-window | `0.1.0` | ✅ |
| `zerodb-local` | ⚠️ **license not declared on PyPI** | n/a | n/a | ⚠️ **Do not use** until license is confirmed; ZeroDB HTTP client instead |
| `zod`, `node:test` | MIT / Node core | long-standing | n/a | ✅ |

**Controls:**
1. `scripts/compliance-check.mjs` runs in CI: for every dependency in the lockfile, resolve license + publish date of the **pinned** version and fail the build on any OSI-unapproved license or any publish date after **2026-08-01**. So it breaks the build instead of relying on us to remember.
2. `zerodb-local` is on a **do-not-use** list until its license is confirmed; a package with no declared license is not "open source" for rule purposes.
3. `prd/` and `docs/` are documentation; all executable code is authored in-window with public commit history.
4. The demo video (due **11:00 Sunday**) shows the live system executing, per the guidance against slide-heavy or AI-generated submissions.

---

## 15. Data Model

**ZeroDB table `omoda_actions`** (append-only, hash-chained; mirrored in the local WAL)

| Field | Type | Notes |
|---|---|---|
| `action_id` | string (PK) | uuid |
| `seq` | int | monotonic per session |
| `prev_hash` / `hash` | string | SHA-256 chain over the canonicalized record |
| `session_id`, `task_id` | string | task grouping; joins the Sequential Thinking plan |
| `agent` | enum | hermes / builder / operator / scout / perceiver |
| `tool`, `args_hash` | string | args hashed, not stored raw (secret hygiene) |
| `tier` | enum | T0 / T1 / T2 / T3 |
| `authority` | string | `envelope` / `operator:<token>` / `denied` / `prohibited` |
| `envelope_refs` | string[] | which policy entries authorized it |
| `model`, `egress` | string | model used; `none` \| `local` \| `hosted` |
| `inverse_ref` | string? | compensating-action record (required for T1) |
| `outcome`, `exit_code`, `latency_ms` | mixed | result |
| `trace_id` | string | OTLP correlation |
| `created_at`, `synced_at` | timestamp | sync lag observable |

**ZeroDB table `omoda_approvals`**: `approval_id`, `action_id`, `token` (single-use), `kind` (`policy_delta`/`undo`), `delta_yaml`, `delta_hash`, `state` (`pending`/`approved`/`denied`/`expired`/`spent`), `chat_id`, `expires_at`, `decided_at`.

**ZeroDB vectors**: embeddings over task descriptions and escalation rationales, for "have we asked this before?" recall.

**ZeroMemory**: `Operator` entity profile; `Preference` and `PriorDecision` memories; Context-Graph edges `task→action`, `action→approval`, `approval→policy_delta`, `task→skill`; skill candidates from promoted `SKILL.md`.

---

## 16. Test Plan

**TDD. The safety negatives are written first, before the Broker exists.** Target **≥ 80%** on the Broker + Ledger service layer (`npm run test:coverage`).

### 16.1 Safety negatives (P0, must be red before any Broker code)
- Every T3 item in §9.4 is refused **with a valid approval token present**, proving no override path exists (US-7, G3).
- A `propose_policy_delta` that would disable `managed_inference`, add an inference host to the network policy, disable device auth, or apply `personal-open-internet` is refused at proposal time (§9.4 item 6).
- An action outside the compiled envelope never executes, for every axis: filesystem, host, port, binary, sub-agent narrowing (G2).
- A T1 action with **no registered inverse** is refused, not downgraded to T0 (G6).
- A bind outside the assigned port block is refused (US-12).
- **Operator-channel hardening holds:** `POST https://api.telegram.org/bot*/setWebhook` from inside the sandbox returns **403**, proving the agent cannot redirect the approval channel and forge its own approvals (R8). Same assertion for `deleteMessage` and `sendDocument`. A non-403 means `protocol: rest` is not in effect and the envelope is not what the policy claims; treated as a build-breaking failure, not a warning.
- **Fail-closed:** envelope read error, ledger write error, and classifier timeout each refuse or escalate, never execute.

### 16.2 Unit
- Envelope compiler: real `policy list` / `policy get` fixtures → expected envelope; and **re-compilation after a policy change** yields the widened envelope.
- Tier classification table across the full action matrix (static path).
- Compensating actions: file snapshot/restore, git ref save/reset, branch delete, each verified by **post-restore hash equality**.
- Approval tokens: single-use, TTL expiry, binding to one `action_id`/`delta_hash`, non-operator chat id rejected.
- Ledger hash-chain integrity; tamper detection on a mutated middle record.
- Telegram intent parsing: `APPROVE`/`DENY`/`UNDO`/`AUDIT`/`STATUS`/`HALT`/`RESUME` + malformed input.
- Model routing: sensitive payload never routed hosted (US-8); multimodal always Omni; Lightning→Omni fallback recorded.

### 16.3 Integration (on the box)
- Live OpenShell denial → T2 escalation → Telegram `APPROVE` → `openshell policy update` → confirmed in `policy list` → original action retried and succeeds (US-5, end to end).
- `DENY` path: refusal returned, denylist honored, no re-escalation in-session (US-6).
- T1 → `UNDO` → verified state restoration (US-4).
- Skill promotion → `nemoclaw omoda rebuild` → skill restored and applied (US-9).
- WAL → ZeroDB sync: at-least-once, idempotent on `action_id`, correct behavior across a simulated partition.
- `HALT` within 2 s under load (US-11).

### 16.4 Benchmark task (the G1 measurement, and the demo)
One fixed, non-trivial task run twice, **per-action-gated control** vs. **OMODA delegated autonomy**, counting human approvals and wall-clock in each:

> *"Add a `/healthz` endpoint to the OMODA service, write its test, get the suite green, commit on a branch, push, and report."*

This touches shell, filesystem writes, package install, git, and (for push) egress: roughly 30–50 gated actions in the control, and a target of **≤ 3** approvals under OMODA. That delta is the whole claim, and this is the experiment that settles it. **We report the number either way.**

---

## 17. Security Considerations

- **Containment is enforced, not requested**: Landlock filesystem confinement, deny-by-default L7 egress, dropped capabilities, gateway credential brokering. The model is untrusted by design.
- **No credential ever enters the sandbox.** NVIDIA, Telegram, and AINative keys live host-side in the OpenShell gateway. Even a fully compromised agent has no key to exfiltrate; this is what makes T0/T1 autonomy defensible.
- **The self-protection clause (§9.4 item 6)** prevents T2 from becoming a privilege-escalation ladder. Reviewed as the highest-severity rule in the codebase.
- **Single choke point**: nine destructive tools, one `broker.authorize()`. The safety property has one place to audit and one place to test.
- **Least privilege per sub-agent**: Scout cannot write outside scratch; Perceiver has no egress at all; Operator cannot touch shared resources.
- **Prompt-injection surface**: all externally fetched content is screened by the guard model **before** entering planner context, and content-derived actions are classified with the fetch provenance attached. An injected instruction still has to pass the Broker, which does not read prompts.
- **Approval integrity**: single-use, time-boxed, delta-bound tokens; only the registered operator chat ID; all other senders logged and ignored.
- **Audit integrity**: hash-chained append-only ledger; args stored as hashes, never raw (secret hygiene); ledger written **before** execution.
- **Blast-radius honesty**: the demo will state plainly what OpenShell does *not* guarantee: capability dropping via `capsh` is documented as best-effort, and Landlock is best-effort on some kernels. Autonomy is scoped to what is actually enforced, and §9.4 hard-denies the rest.

---

## 18. Rollback Plan

- **`HALT`**: Broker enters `refuse-all` in < 2 s; no new action admitted. The primary control (US-11).
- **`UNDO <token>`**: per-action reversal via the registered inverse, hash-verified.
- **Session rollback**: replay all inverses for a session in reverse `seq` order (`omoda rollback --session <id>`), for when a whole run went wrong.
- **Policy rollback**: every applied delta is recorded with its inverse; `omoda policy revert <approval_id>` removes it and recompiles the envelope. Policy is hot-reloadable, so this takes seconds.
- **Sandbox rollback**: `nemoclaw omoda rebuild` returns to the blueprint image; approvals made in-session are intentionally **not** persisted across recreation (OpenShell semantics), so a rebuild is a full authority reset. Skills survive via ZeroMemory promotion; that asymmetry is deliberate: **knowledge persists, authority does not**.
- **Full stop**: `nemoclaw omoda stop` removes the sandbox. The host vLLM and the sibling project are unaffected by construction.

---

## 19. Timeline

Build window: **Fri evening 2026-08-14 → Sun 11:00 2026-08-16** (demo video due 11:00 Sunday).

| Phase | Window | Work | Exit criteria |
|---|---|---|---|
| **P0: Safety core** | Fri PM | **R1/R2 already resolved** (§13). Remaining spike: **R3** (port block), blocking. Write §16.1 negatives **first**, including the R8 `setWebhook` 403 assertion. Envelope compiler + tier classifier + ledger. Create the `omoda` sandbox with `agent: hermes`. | R3 answered in writing; safety negatives red→green; envelope compiles from live policy; hardened Telegram policy applied and `setWebhook` returns 403 |
| **P1: Broker + Telegram** | Sat AM | Broker choke point, compensating-action registry, Telegram channel + policy, intent parsing, `HALT` | T0 executes silently; T1 executes with working `UNDO`; `HALT` < 2 s |
| **P2: T2 escalation loop** | Sat PM | OpenShell denial interception, policy-delta proposal, approve→apply→retry, denylist | **US-5 works end to end on the box.** The money shot |
| **P3: Multi-model + sub-agents** | Sat PM/eve | Lightning planner via gateway, Omni perception + risk classifier, sensitivity routing, four sub-agents with narrowed envelopes | ≥ 2 models load-bearing with per-role call counts in the ledger; third if memory permits |
| **P4: Memory, skills, audit** | Sat eve | ZeroDB sync, ZeroMemory recall, skill promotion + rebuild survival, `AUDIT` | US-9 and US-10 demonstrated; sync survives a simulated partition |
| **P5: Benchmark & harden** | Sun AM | Run §16.4 **both ways**, record the number; coverage ≥ 80%; compliance check green | **G1 measured and reported honestly**; G11 green in CI |
| **P6: Demo video** | Sun by 11:00 | Live execution: task in → autonomous run → one T2 escalation approved on the phone → `UNDO` → `AUDIT` | Submitted on time |

**Scope discipline.** P0–P2 are the thesis. Not negotiable. P3's third model, P4's GraphRAG depth, and the `Scout` agent are the declared cut list if time runs short.


---

## 20. Open Questions

1. **Port block**: what 100-port range is OMODA assigned? `~/team.conf` and `~/env.sh` were not readable on the shared `acer01` account. **Blocking before any listener binds** (R3).
2. **Team composition**: the rules require **teams of 3+**. Roster and role split (Broker / Telegram+HERMES / demo+benchmark) must be confirmed Friday.
3. ~~**HERMES vs OpenClaw**~~. **RESOLVED.** The Telegram manifest declares `supportedAgents: ["openclaw", "hermes"]` with a Hermes-specific policy, so HERMES is selectable at sandbox creation. No blueprint refresh needed. OpenClaw stays as an in-build fallback only if the Hermes bridge misbehaves.
4. **Lightning bounty framing**: is routing Lightning as the *planner brain via the gateway* a sufficiently "meaningful incorporation" for the bounty, or do judges expect local execution? Local is physically impossible at ~6 GiB free; worth a 2-minute check with an NVIDIA rep on site.
5. **Third model**: ship the ≤3B guard model, or fold the role into Omni and claim two? **Recommendation: attempt at boot, fall back automatically, and report what actually ran.** Never claim three if two ran.
6. **T1 default TTL**: 30 min for `UNDO` is a guess. Long enough that a distracted operator can still reverse; short enough that snapshots do not accumulate. Revisit after the benchmark.
7. **Demo egress**: will venue networking allow `integrate.api.nvidia.com` and `api.telegram.org`? If Telegram is blocked the operator channel dies. **Contingency: a local Telegram-shaped webhook stub on the tailnet, disclosed as such.**
8. **AINative egress approval**: approve `api.ainative.studio` during the demo (showcasing the T2 flow on our own dependency, which is a nice touch), or pre-approve it to avoid demo risk? **Recommendation: pre-approve; demo the T2 flow on `api.github.com` instead**, where a denial is harmless.
