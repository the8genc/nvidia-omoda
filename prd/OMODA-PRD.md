# OMODA: Orchestrated Multi-model Operator with Delegated Autonomy

**Agent Capability PRD**

**Author:** Arif Gursel (ag@getonpace.org) · 8genC
**Date:** 2026-08-15 · **Revised:** 2026-08-15 (v2, three-layer architecture on Paperclip)
**Status:** Draft, pre-build (build window opens Fri 2026-08-14 evening)
**Slug:** `omoda`
**Repo:** [the8genc/nvidia-omoda](https://github.com/the8genc/nvidia-omoda)
**Sibling project (shares the box):** [the8genc/leftovers](https://github.com/the8genc/leftovers)
**Event:** NVIDIA Spark Hackathon, Seattle (Aug 14 to 16, thinkspace) · **Track: Do** · targeting **Best Use of NVIDIA Nemotron**
**Companion:** [`prd/ARCHITECTURE-ANALYSIS.md`](./ARCHITECTURE-ANALYSIS.md)

---

## 1. Capability Overview

### The thesis

> **An approval should not be a request that an agent behave. It should be the thing that creates the capability.**

Every agent platform today holds the capability open and asks the model not to use it yet. OMODA inverts that: for any action that can cost money, create liability, or speak in our name, the write method does not exist in the sandbox policy at all. A recorded human decision is what materializes it, scoped and time-boxed, and the runtime reverts it afterwards. Everything that is not such an action runs unattended at full speed.

### What this system is

OMODA is a **policy layer between two proven systems**, and it is the only part we build.

| Layer | System | Owned by | Question it answers |
|---|---|---|---|
| 1. Orchestration | **Paperclip**, upstream, unmodified | paperclipai, MIT | Who does the work, when, under what budget, and who signs off? |
| 2. Policy determination | **OMODA Policy Compiler + Autonomy Broker** | **us** | Given what this skill declared, what may it reach and what needs consent? |
| 3. Protections | **NVIDIA OpenShell**, via NemoClaw | NVIDIA, Apache-2.0 | Can this process actually do that? |

Paperclip supplies the org chart, heartbeat scheduling, tasks, budgets, review and approval stages, and an immutable decision log, at 78,237 stars and 14,351 forks. OpenShell supplies Landlock filesystem confinement, deny-by-default L7 egress, dropped Linux capabilities, and gateway-side credential brokering. Neither knows about the other. OMODA is the compiler that makes a Paperclip approval decision physically govern an OpenShell capability.

The seam is verified, not assumed. See §14.1.

### Agent type

**Always-on, multi-agent, heartbeat-driven.** Paperclip wakes agents on `timer`, `assignment`, `on_demand`, or `automation`. Each agent runs inside its own OpenShell sandbox with an envelope compiled from its declared skills. The Broker and the ledger are long-running services. The Acer GN100 is what makes always-on practical: the models are resident locally and the box never sleeps.

### Target users

- **Primary, the operator.** Wants a team of agents doing real work continuously, and wants to be interrupted only when a decision genuinely requires a human.
- **Secondary, the reviewer.** Must answer "what did it do, under whose authority, and can we undo it" from a ledger rather than chat scrollback.
- **Tertiary, hackathon judges**, who weigh systems engineering, NVIDIA ecosystem use, and whether the agent does something a person would otherwise do by hand.

---

## 2. Problem Statement

Agent platforms fail in three ways, and the third is the interesting one.

**Failure mode 1: the approval treadmill.** Gate every irreversible action on a human. Correct, and it is what responsible systems do. But it caps throughput at human response latency, and after the fortieth `YES` the human is rubber-stamping, so the gate has become theater. Our own prior system, `chief-of-staff`, is this design.

**Failure mode 2: trust by prompt.** Let the agent run and instruct it not to do dangerous things. A system prompt is not a security boundary. It does not survive a jailbreak, a confused tool call, or a poisoned web page.

**Failure mode 3, the one nobody talks about: solved orchestration on an unsandboxed floor.** Paperclip is excellent at deciding who does what, when, and who reviews it. Its own runtime documentation then says:

> "Local CLI adapters run unsandboxed on the host machine. That means: prompt instructions matter, configured credentials/env vars are sensitive, working directory permissions matter."

Paperclip's execution policy is genuinely runtime-enforced, and its stated design principle is "runtime-enforced, not prompt-dependent". But it enforces review of the **work product**: it intercepts a transition to `done` and routes the issue to a reviewer. It does not enforce anything about the **action**. An agent sitting in `in_progress` can run any command, delete any path, and reach any host. The review happens after.

So: mature orchestration governs the deliverable, and nothing governs the blast radius.

**What is missing** is a layer that reads what a skill declared, compiles it into both a containment policy and a consent requirement, and then makes the consent decision the physical precondition for the capability. That layer does not exist in either system, and it is small enough to build in a weekend because both neighbours are already built.

---

## 3. Prior Art

Two control conditions, both ours to compare against honestly.

### 3.1 PACE / GarV

`agents.getonpace.org` and `the8genc/chief-of-staff`. L0 orchestrator, proxy layer carrying Knowledge, Elder and Analyst faculties, L1 domain agents, L2 platform workers. Its invariant:

> *"no email is ever sent without a valid, unexpired, principal-issued approval token"*, enforced at one service-layer choke point (`sendGate.js`) and proven by a negative test.

**Proves:** a single choke point is auditable and testable. The invariant held.
**Costs:** the gate lives in code we wrote. A path that reaches the Gmail client without traversing `sendGate.js` silently voids it. And a human waits in every loop.

### 3.2 Paperclip

`paperclipai/paperclip`, MIT, public since 2026-03-02. Heartbeats, org chart, `executionPolicy` with ordered review and approval stages, `issue_execution_decisions` as an audit trail, per-agent budgets with automatic pause, a skills catalog with `trustLevel` and per-file `sha256`, and adapters including `hermes_local`, `hermes_gateway`, and `openclaw_gateway`.

**Proves:** orchestration at scale is solved, and work-product review can be runtime-enforced.
**Costs:** the execution floor is unsandboxed, by its own documentation.

### 3.3 What changes

| Element | chief-of-staff | Paperclip | OMODA |
|---|---|---|---|
| Orchestration | Built by us | **Mature, adopted** | **Reused unchanged** |
| Consent model | Approval token in app code | Workflow stage | **Capability materialization** |
| Enforcement of consent | Application service layer | Application runtime | **Kernel and L7 proxy** |
| Blast radius | Host permissions | Host permissions | **Landlock, deny-by-default egress, dropped caps** |
| Gate placement | Every action | Every deliverable | **Only consequential writes** |
| Failure of the gate | Bug voids it | Agent acts before review | Action is unreachable, so nothing to void |

The honest framing: GarV proved we can build the safe-but-slow version. Paperclip proved the fast version at scale but left the floor open. OMODA connects the two, and the measurement in §4 says whether that was worth doing.

---

## 4. Goals & Success Metrics

| # | Goal | Metric | Target | How measured |
|---|---|---|---|---|
| G1 | **Autonomy pays off** | Human decisions per completed benchmark task, versus a per-action-gated control run of the same task | **10x reduction or better** | Ledger count, both modes, same task |
| G2 | **Consent is physically enforced** | Consequential writes executed without a matching recorded Paperclip decision | **0**, and the capability absent from policy until the decision exists | Ledger cross-checked against `issue_execution_decisions`, asserted in CI |
| G3 | **Undeclared is denied** | Tool calls succeeding that were absent from the skill manifest | **0** | Negative tests, §18.1 |
| G4 | **The shared box survives** | `leftovers` outages caused by OMODA; OOM kills of the shared vLLM; binds outside 3100 to 3199 | **0** | `spark-status.sh` sampling, port audit, incident log |
| G5 | **Policy reverts** | Approval-scoped deltas still present after the action completes or the window expires | **0** | Envelope diff after each escalated action |
| G6 | **Irreversible actions recoverable** | Update and delete actions with a working inverse registered before execution | **100%** | Broker refuses without a registered inverse |
| G7 | **Multi-model is load-bearing** | Distinct Nemotron models carrying distinct roles, each with a measured share of calls | **2 minimum, 3 if memory allows** | Ledger `model` field per role |
| G8 | **Audit completeness** | Dangerous actions with a complete ledger record | **100%** | Schema validation over the ledger |
| G9 | **Operator latency** | Median: escalation sent, decision recorded, policy applied, action retried | **under 60 s** | Ledger timestamps |
| G10 | **Test quality** | Coverage on Broker, Compiler, and Ledger | **80% or better** | `npm run test:coverage` |
| G11 | **Rules compliance** | Dependencies failing the two-week open-source rule | **0** | `scripts/compliance-check.mjs` in CI |

---

## 5. User Stories

Given / When / Then. "Operator" is the human. "Board" is Paperclip's term for operator-level authority.

### US-1: Delegate a long-running job and walk away
**As an** operator, **I want** to file a task in Paperclip and leave, **so that** work proceeds overnight without a queue of approvals.

- **Given** agents whose envelopes are compiled from their declared skills,
- **When** I create a Paperclip issue and assign it,
- **Then** the assigned agent heartbeats, works inside its sandbox, and I receive only: consequential-write escalations, post-hoc notices for contained writes, and a final summary. Every action is in the ledger.

### US-2: A safe read runs with no human and no ceremony
- **Given** a tool whose manifest declares `verb: read`,
- **When** the agent calls it,
- **Then** the Broker classifies it safe, OpenShell permits it under `access: read-only` with methods `[GET]`, it executes, and no notification is sent.

### US-3: A contained write runs, ledgered, with an inverse
- **Given** a write whose manifest declares an empty `impact` list and whose target is inside the envelope,
- **When** the Broker classifies it,
- **Then** it registers a compensating action first, refuses if no inverse can be registered, executes, and posts one notice carrying `UNDO`.

### US-4: A consequential write is impossible until a decision exists
**As an** operator, **I want** money-moving actions to be unreachable rather than merely discouraged.

- **Given** a tool declaring a write verb with a non-empty `impact` list, for example `quickbooks.invoice.create` with `impact: [financial]`,
- **When** the agent attempts it with no recorded decision,
- **Then** OpenShell refuses at the L7 proxy with 403, because the policy grants `read-only` and the write method is absent, and the Broker records the refusal and opens a Paperclip execution stage.

### US-5: The decision materializes the capability
- **Given** a pending Paperclip approval stage for that action,
- **When** the participant records `approved` with the required comment,
- **Then** the Broker verifies the decision is genuine (correct issue, stage, participant, not the original executor, comment present), hot-reloads a policy delta granting exactly that one method and path, retries the action, and reverts the delta on completion or expiry.

### US-6: A denial sticks and costs nothing
- **When** the participant records `changes_requested` or the window expires,
- **Then** the delta is never applied, the capability stays absent, the Broker returns a structured refusal, and it does not re-escalate the same action in the same session.

### US-7: Prohibited actions have no decision path at all
- **Given** anything on the prohibited list (§9.5): the shared vLLM on `:8000`, ports outside 3100 to 3199, the host Docker socket, `$HF_HOME`, credential exfiltration, or a policy delta that would weaken OpenShell itself,
- **When** requested by any agent, through any path, with any decision recorded,
- **Then** the Broker refuses, raises an incident rather than an approval request, and no code path exists that can execute it. Proven by a negative test with a valid decision present.

### US-8: Turning on a skill provisions exactly its envelope
**As an** operator, **I want** to enable a skill and have the sandbox reflect it, **so that** capability tracks declaration.

- **Given** a skill with an `omoda.skill.yaml` manifest,
- **When** I enable it for an agent,
- **Then** the Compiler emits an OpenShell policy fragment and a Paperclip `executionPolicy`, applies both, and the agent's capability table (§11) updates. Disabling removes the fragment.

### US-9: Perception without egress
- **Given** a task requiring reading screenshots, logs, or video,
- **When** the Perceiver handles it,
- **Then** inference runs against the local Nemotron 3 Nano Omni endpoint only, its policy grants no egress at all, and the Broker refuses to route that payload to a hosted model even if the planner asks.

### US-10: Ask what it did, from a phone
- **When** I send `AUDIT last 2h` or `AUDIT tier:consequential` over Telegram,
- **Then** I get a compact chronological list: timestamp, agent, tool, verb, impact, authority, outcome, model, with the Paperclip issue id for anything that required a decision.

### US-11: Kill switch
- **When** I send `HALT`,
- **Then** the Broker enters refuse-all within 2 s, in-flight actions finish but no new one is admitted, all approval-scoped deltas revert immediately, and only `RESUME` re-admits actions.

### US-12: The sibling project is never collateral damage
- **When** OMODA allocates any resource,
- **Then** it binds only inside 3100 to 3199, pre-checks free memory against a floor before any heavy step, and aborts with a notice rather than risking the shared vLLM.

---

## 6. Features

### 6.1 What we build (Layer 2 only)

1. **Skill manifest and Policy Compiler.** Reads `omoda.skill.yaml` beside Paperclip's existing `SKILL.md`. Emits an OpenShell policy fragment and a Paperclip `executionPolicy`. The only writer of policy in the system.
2. **Autonomy Broker.** The single choke point. Classifies every action on verb, impact, and envelope. Enforces inverse registration. Converts OpenShell denials into Paperclip execution stages. Applies and reverts approval-scoped deltas.
3. **Approval-scoped capability.** Decision verification, time-boxed policy delta, retry, guaranteed revert.
4. **Action Ledger.** Hash-chained append-only local WAL, fsynced before execution, replicated to ZeroDB. Cross-referenced to Paperclip decision ids.
5. **Capability registry.** The generated per-agent table of tools, verbs, impact domains, grants, and consent requirements (§11).
6. **Telegram operator channel.** Escalations, `UNDO`, `AUDIT`, `HALT`. Decisions are written back into Paperclip so Paperclip remains the system of record.
7. **Model routing.** Sensitivity-aware routing across the Nemotron models (§7).
8. **Shared-box guard.** Port-block enforcement, memory floor pre-checks, bounded concurrency against the shared vLLM.

### 6.2 What we explicitly do not build

Org chart, task model, heartbeat scheduler, budget tracking, review and approval workflow state, decision audit table, skills catalog, web UI. All Paperclip, upstream, unmodified. Rebuilding any of it would cost the weekend and score badly against a rubric that rewards depth over reimplementation.

### 6.3 Non-functional requirements

- **Fail closed.** Any classification error, policy read failure, ledger write failure, or failed revert refuses the action and halts the Broker.
- **Undeclared is denied.** A tool absent from the manifest gets no egress entry and no filesystem grant, so it fails at Layer 3 rather than relying on Layer 2 to notice.
- **Offline first.** The core loop must work with the local model and local WAL alone. Paperclip is on the tailnet; ZeroDB sync and hosted Lightning are enhancements that degrade gracefully. We hit AINative outages mid-build on chief-of-staff. Assume it happens again.
- **Resource discipline.** 121 GiB unified memory with about 115 already used. OMODA must not load a model. Abort any step that would take free memory below 4 GiB.
- **Latency.** Static classification under 50 ms p95; under 1.5 s when the Omni classifier is consulted; escalation to retry under 60 s median.
- **No credential in the sandbox.** NVIDIA, Telegram, Paperclip and AINative credentials are all brokered by the OpenShell gateway.

---

## 7. The System of Models

| Role | Model | Where | Why here |
|---|---|---|---|
| **Planner and tool-caller** | `nvidia/nemotron-3.5-lightning-30b-a3b` | Hosted, `https://integrate.api.nvidia.com/v1`, routed through the OpenShell gateway | Built for agent harnesses: leading accuracy on tool calling, instruction following, and multi-turn work. Hosted because the box has about 6 GiB free and a second 30B model cannot load. The gateway holds the key; the agent never sees it |
| **Perception and risk classification** | `nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-NVFP4` | Local, vLLM on `:8000`, already running and shared | Text, image, video and audio in one model, so no separate VLM. On-box, so sensitive artifacts are classified with zero egress, which is the real reason it stays local. Doubles as the Broker's semantic classifier when static rules are inconclusive |
| **In-sandbox guard and router** | Small local model, 3B or under, NVFP4 | Local, in-sandbox, **memory-gated** | Cheap intent routing and prompt-injection screening on untrusted fetched content, kept off the shared vLLM queue. Loads only if free memory is 6 GiB or more at boot. Otherwise this role folds into Omni and the ledger records the fallback. Better to ship two we actually ran than claim three we could not fit |

**Routing rules, enforced in the Broker rather than the prompt:**

1. Payload classified sensitive goes local only. A hosted route for such a payload is refused and logged.
2. Multimodal input goes to Omni, always.
3. Planning and tool selection go to Lightning when egress is available, falling back to Omni with a recorded quality caveat.
4. Untrusted fetched content is screened by the guard model before it reaches planner context.

---

## 8. Danger Taxonomy

Two independent axes. Axis 1 decides **which mechanism applies**. Axis 2 decides **who must consent**.

### 8.1 Axis 1: dangerous actions, from the CRUD verb

Mechanically determinable from the call itself, so it cannot be misdeclared.

| Verb | Class | Reversible by construction |
|---|---|---|
| Read | safe | n/a |
| Create | write | yes, delete what was created |
| Update | write | only with a pre-image snapshot |
| Delete | write | only with a pre-image snapshot |

### 8.2 Axis 2: dangerous outcomes, from the blast domain

Declared per tool in the skill manifest.

- **Financial:** moves money, incurs cost, changes a price, issues a credit.
- **Legal:** creates or alters a contractual or regulatory obligation, touches regulated or personal data.
- **Reputational:** anything a third party sees under our name. Outbound messages, published content, public commits.

### 8.3 The resulting matrix

| | Read | Create | Update | Delete |
|---|---|---|---|---|
| **No impact domain** | Autonomous. `access: read-only`, `[GET]` | Autonomous, ledgered | Autonomous, ledgered, inverse required | Autonomous, inverse required, `UNDO` offered |
| **Financial / legal / reputational** | Autonomous, logged as sensitive read | **Approval-scoped write** | **Approval-scoped write**, inverse required | **Approval-scoped write**, inverse required, two-person rule |

Reads are safe. Writes are governed. Writes that can produce a dangerous outcome are not merely governed, they are **absent from the policy** until a decision exists.

---

## 9. Technical Architecture

### 9.1 Topology

```
┌─ Acer Veriton GN100 · gn100-390c · GB10 · aarch64 · 121 GiB unified ──────────────┐
│                                                                                    │
│  HOST                                                                              │
│   ├─ vLLM (:8000)   Nemotron-3-Nano-Omni-30B-A3B-Reasoning-NVFP4      [SHARED]     │
│   ├─ Paperclip (:3100)  org chart · heartbeats · tasks · budgets · decisions       │
│   ├─ NemoClaw v0.0.90 · OpenShell 0.0.85                                           │
│   └─ OpenShell gateway  ── holds ALL credentials ──┐                               │
│                                                    │                               │
│   Paperclip ──openclaw_gateway adapter (ws, v4)──▶ │  verified §14.1               │
│        ▲                                           │                               │
│        │ decisions in / escalations out            │                               │
│  ┌─────┴──────────────── LAYER 2 ──────────────────┼─────────────────────────────┐ │
│  │  POLICY COMPILER            AUTONOMY BROKER     │                             │ │
│  │  omoda.skill.yaml           classify(verb,      │                             │ │
│  │     ├─▶ OpenShell fragment    impact, envelope) │                             │ │
│  │     └─▶ executionPolicy      approval-scoped    │                             │ │
│  │                              delta apply/revert │                             │ │
│  │  ACTION LEDGER (hash-chained WAL ─sync─▶ ZeroDB / ZeroMemory)                 │ │
│  └─────┬──────────────────────────────────────────┼─────────────────────────────┘ │
│        │ openshell policy set / update            │                               │
│  ┌─────▼─ LAYER 3 · OpenShell sandbox per agent ──┼─────────────────────────────┐ │
│  │  Landlock FS · deny-by-default L7 egress · caps dropped · cred brokering     │ │
│  │  /usr/local/bin/openclaw  ·  Hermes harness  ·  agent sub-envelopes          │ │
│  └──────────────────────────────────────────────────────────────────────────────┘ │
│                                                    │                               │
│   Operator ◀── Telegram (escalate / UNDO / AUDIT / HALT) ──▶ writes decision back   │
│   integrate.api.nvidia.com (Lightning) ◀───────────┘   key never in sandbox        │
└────────────────────────────────────────────────────────────────────────────────────┘
```

### 9.2 The Policy Compiler

Input: `omoda.skill.yaml`. Output: two artifacts, applied atomically.

1. **OpenShell policy fragment.** Egress entries with methods derived from the declared verbs: read compiles to `[GET]`, writes compile to the corresponding methods **only when `impact` is empty**. Filesystem grants from the declared read and write paths. Binaries scoped to the agent's harness.
2. **Paperclip `executionPolicy`.** A `review` stage when any declared capability is a write with a non-empty impact list; an `approval` stage when that impact includes financial or legal; a two-person rule for deletes.

The Compiler is the only writer of policy. Recompilation happens on every skill enable, disable, or manifest change, and the Broker re-reads the envelope after every change rather than caching it.

### 9.3 The Autonomy Broker

Deterministic first. The model is consulted only when static rules are inconclusive, and a model that cannot decide yields escalation, never execution.

```
                        ┌───────────────────────────┐
   action request ─────▶│ 1. On the prohibited list?│──yes──▶ REFUSE + incident
                        └─────────────┬─────────────┘         (no decision path)
                                      │ no
                        ┌─────────────▼─────────────┐
                        │ 2. Declared in manifest?  │──no───▶ REFUSE (undeclared)
                        └─────────────┬─────────────┘
                                      │ yes
                        ┌─────────────▼─────────────┐
                        │ 3. Verb == read?          │──yes──▶ EXECUTE · ledger · silent
                        └─────────────┬─────────────┘
                                      │ no (write)
                        ┌─────────────▼─────────────┐
                        │ 4. impact == [] ?         │──yes──▶ register inverse ─┬─ ok ──▶ EXECUTE
                        └─────────────┬─────────────┘                          │       + UNDO notice
                                      │ no                                     └─ none ▶ REFUSE
                        ┌─────────────▼─────────────┐
                        │ 5. Recorded decision for  │──no───▶ 403 from OpenShell (method absent)
                        │    THIS action?           │         open Paperclip stage · escalate
                        └─────────────┬─────────────┘
                                      │ yes, verified
                                      ▼
                        apply scoped delta ▶ retry ▶ REVERT (always)
```

**Fail-closed guarantees.** Envelope read fails, refuse all. Ledger write fails, refuse. Classifier times out, escalate. Failed revert, halt the Broker and raise an incident. Broker crash, agents have no alternate path to tools, so work stops rather than proceeding ungoverned.

### 9.4 Approval-scoped capability, in detail

1. Default compiled state for a consequential tool: `access: read-only`, methods `[GET]`, `protocol: rest`, `enforcement: enforce`.
2. Agent attempts the write. The L7 proxy refuses with 403 **below the agent**, so no prompt, jailbreak, or injected instruction can produce it.
3. Broker opens or advances a Paperclip execution stage against the issue and notifies the participant over Telegram.
4. Participant records the decision in Paperclip (`PATCH /api/issues/{id}` with status and the required comment). Paperclip writes `issue_execution_decisions`.
5. Broker verifies: correct issue, correct stage, correct participant, participant is not the original executor, comment present, decision not already spent.
6. Broker applies a delta adding exactly one method on exactly one path, bounded by a TTL.
7. Action retried, outcome ledgered with the decision id as its authority.
8. Delta reverted on completion or expiry, whichever comes first. Revert is verified by re-reading the envelope.

### 9.5 The prohibited list (no decision path exists)

Checked before everything else. Unreachable by any decision.

1. The shared vLLM on `:8000`: stop, restart, reconfigure, or any allocation risking OOM.
2. Any port outside **3100 to 3199**, especially the neighbouring blocks (tiruye 3200s, fredrik 3300s, koti 3400s, praveen 3500s).
3. The host Docker socket, host `systemd`, or any container other than OMODA's own.
4. `$HF_HOME`, the shared 43 GB model cache. No writes, no deletes.
5. Credential exfiltration: reading gateway config, env dumps to network, or any attempt to obtain the brokered keys.
6. **Policy deltas that weaken enforcement:** disabling `managed_inference`, adding an inference host directly to the network policy (which would bypass credential brokering), disabling gateway device auth, or applying `personal-open-internet`.
7. Destructive git on shared refs: force-push to `main`, deleting a non-OMODA branch, history rewrite.
8. Any write outside the Landlock-permitted workspace.

Item 6 is the one to watch. Call it the **self-protection clause**. The Broker's authority derives from OpenShell policy, so it refuses to broker changes that would dismantle OpenShell. Without it, the approval path is a privilege-escalation ladder: propose "just add the inference host directly", collect a tired approval, and thereafter hold a real credential. This is the single most important rule in the system.

### 9.6 Layering

- **Handlers.** Telegram webhook, Paperclip webhook, MCP tool entrypoints. Validate with `zod`, call the service layer, return. No business logic.
- **Service layer.** Compiler, Broker, Ledger, compensating-action registry, model routing. The only layer that may invoke a dangerous tool.
- **Adapters.** OpenShell and NemoClaw CLI, Paperclip REST, Telegram, vLLM and NVIDIA inference, ZeroDB and ZeroMemory. Interfaces plus stubs, each self-disabling if unconfigured.

Node.js (ESM, 20.6 or later), matching both the Paperclip and NemoClaw ecosystems. Tests with `node:test`.

---

## 10. Skill Manifest

The platform is skill-agnostic: it knows only what a skill declares. Paperclip's catalog already carries `trustLevel` (`markdown_only`, `assets`, `scripts_executables`), but that describes what the skill file *contains*, not what it *does*. The sidecar adds behaviour.

```yaml
# omoda.skill.yaml, alongside the existing SKILL.md
skill: invoice-dispatch
capabilities:
  - tool: quickbooks.invoice.read
    verb: read
    resource: quickbooks:invoice
    impact: []                      # safe, always autonomous
  - tool: quickbooks.invoice.create
    verb: create
    resource: quickbooks:invoice
    impact: [financial]             # approval-scoped write
  - tool: quickbooks.invoice.void
    verb: delete
    resource: quickbooks:invoice
    impact: [financial, legal]      # approval-scoped, inverse required, two-person
egress:
  - host: quickbooks.api.intuit.com
    port: 443
filesystem:
  read:  [/workspace]
  write: [/workspace/out]
```

Enabling the skill provisions a sub-agent whose envelope is exactly this and nothing more. Disabling removes it. A skill cannot widen its own reach, because the Compiler is the only writer of policy and the manifest is its only input.

**The verb is derived from the call, not trusted from the manifest.** A write cannot masquerade as a read, because the HTTP method and the syscall are what OpenShell sees. The manifest is trusted only for `impact`, which is why manifest changes are themselves reviewed (§19).

---

## 11. Agent Capability Registry

Generated from the manifests, not hand-written. This is the artifact that answers "which agents have which tool outcomes, and what can they do that is dangerous".

| Agent | Tool | Verb | Impact | OpenShell grant | Consent required |
|---|---|---|---|---|---|
| **Scout** | `http.get` | read | none | `GET` on allowed hosts | none |
| **Scout** | `fs.write` (scratch) | create | none | `/workspace/scratch` only | none, ledgered |
| **Builder** | `fs.write` | update | none | workspace write | none, inverse required |
| **Builder** | `git.commit` | create | none | workspace write | none, ledgered |
| **Builder** | `git.push` | update | reputational | `read-only` until approved | review stage |
| **Perceiver** | `omni.perceive` | read | none | local endpoint only, **egress denied entirely** | none |
| **Operator** | `shell.exec` | update | none | workspace only, port block only | none, inverse required |
| **Operator** | anything on `:8000`, `$HF_HOME`, other ports | any | n/a | **denied, prohibited list** | **none possible** |
| **Comms** | `telegram.sendMessage` | create | reputational | `POST` one path, approval-scoped | approval stage |
| **Finance** | `quickbooks.invoice.read` | read | none | `GET` only | none |
| **Finance** | `quickbooks.invoice.create` | create | financial | `read-only` until approved | approval stage |
| **Finance** | `quickbooks.invoice.void` | delete | financial, legal | `read-only` until approved | approval, two-person, inverse |

Sub-agents never inherit the full envelope. Scout cannot write outside scratch. Perceiver has no egress at all. Operator cannot touch shared resources under any decision.

---

## 12. Paperclip Integration

| Concern | Mechanism |
|---|---|
| Agent runtime | `openclaw_gateway` adapter, WebSocket protocol v4, to the OpenShell-contained OpenClaw. Verified §14.1 |
| Alternative runtime | `hermes_gateway` or `hermes_local`, both shipped by Paperclip, if the Hermes harness proves a better fit |
| Wakeups | Paperclip heartbeats: `timer`, `assignment`, `on_demand`, `automation`, coalesced |
| Consent | Paperclip `executionPolicy` stages, compiled by us and applied through Paperclip's API |
| Decision record | `issue_execution_decisions`, Paperclip's table, referenced by ledger entries |
| Budgets | Paperclip per-agent budgets with automatic pause. We add no cost tracking |
| Deployment | Self-hosted on the box, port **3100**, which is both our block base and Paperclip's own `PAPERCLIP_HOST_PORT` default |

Telegram does not replace Paperclip's board. It is the mobile surface: it notifies, collects a one-tap decision, and writes that decision back into Paperclip so Paperclip stays the system of record. The hardened Telegram policy already in the repo grants exactly the methods this needs (`getUpdates`, `sendMessage`, `answerCallbackQuery`, `editMessageText`, `editMessageReplyMarkup`, `getMe`) and excludes `setWebhook`, which would let an agent redirect the approval channel and forge its own decisions.

---

## 13. AINative Integration

- **ZeroDB** (`/api/v1/zerodb`): durable system of record for the action ledger and the compiled-policy registry, vectors over prior decisions, event streaming, file storage for pre-action snapshots.
- **ZeroMemory** (`/api/v1/public/memory/v2`): operator preferences and prior decisions, entity profile, Context Graph linking task to action to decision to skill, skill candidates, decision traces.
- **Sequential Thinking:** per-task reasoning chains as plan artifacts, so any ledger entry traces to its rationale.
- **Chat Completions API:** tertiary fallback only, if both Lightning and Omni are unavailable. NVIDIA models are the point of the project.
- **Agent Cloud:** deliberately not used. The workload runs on the GN100; OpenShell provides the sandboxing and credential vaulting Agent Cloud would otherwise supply.

The local hash-chained WAL is the durability mechanism, fsynced before any action executes. ZeroDB is the system of record. Reaching AINative requires an egress entry, which is itself proposed through the normal consent flow.

---

## 14. Ground Truth

Verified by direct inspection on 2026-08-15. Access is `ssh gn100` as the `arif` account; the shared `acer01` login and anything under `/home/acer01` are off-limits per the team's shared-infra doc.

| Item | Verified value | Consequence |
|---|---|---|
| Host / arch | `gn100-390c`, `aarch64`, NVIDIA **GB10** | ARM64 images only |
| Memory | **121 GiB total, 115 used, about 6 free** | **OMODA must not load a model.** Third model memory-gated |
| Local model | `Nemotron-3-Nano-Omni-30B-A3B-Reasoning-NVFP4`, vLLM `:8000`, 131 072 ctx | Perception and classifier endpoint. Shared, so bound concurrency |
| NemoClaw / OpenShell | CLI **v0.0.90**, OpenShell **0.0.85**, driver docker | Policy round-trip needs 0.0.72+, satisfied |
| OpenClaw gateway | **OpenClaw Control on `:18789`**, `/health` returns `{"ok":true,"status":"live"}` | The Paperclip integration point |
| Sandbox contents | `/usr/local/bin/openclaw` present **inside** the OpenShell sandbox | OpenClaw runs contained |
| Hermes | Installed at `~/.hermes/hermes-agent`; manifest declares `supportedAgents: ["openclaw","hermes"]` | Either harness is selectable |
| **OMODA port block** | **3100 to 3199**, `PORT_BASE=3100`, all 100 free | Bind only here. Paperclip's own default host port is 3100 |
| Workspace | `OMODA_DIR=/home/arif/omoda`, repo cloned | Work here, never under `/home/acer01` |
| Ports in use | `22, 53, 631, 5180, 8000, 8080, 8091, 11000, 11002, 18789, 49065, 62524` | None inside our block |
| Landlock | `compatibility: best_effort` in the baseline | Scope autonomy to what the kernel actually enforces |
| Model cache | `$HF_HOME`, 43 GB, shared | Prohibited, no writes |

### 14.1 The verified seam

Paperclip's `openclaw_gateway` adapter expects WebSocket frames `{type:"req"|"res"|"event"}`, `PROTOCOL_VERSION = 4`, method `connect`, client `gateway-client` / mode `backend` / role `operator` / scopes `["operator.admin"]`, then a nonce challenge signed with an Ed25519 device identity.

Replaying that exact frame against `ws://127.0.0.1:18789` returned:

```
WS OPEN (upgrade accepted)
SENT connect (protocol v4)
RECV {"type":"event","event":"connect.challenge",
      "payload":{"nonce":"b95b2426-8e0a-4dc5-831a-c9323bde2f65","ts":1786807750042}}
RECV {"type":"res","ok":false,
      "error":{"code":"NOT_PAIRED","message":"device identity required",
               "details":{"code":"DEVICE_IDENTITY_REQUIRED"}}}
```

The gateway accepted the upgrade, protocol v4, and Paperclip's exact client identity and scopes, then answered with the nonce challenge the adapter is written against. It refused for one reason: no device identity. Pairing is implemented in the adapter already (`device.pair.list`, `device.pair.approve`, `autoPairOnFirstConnect`). Identical responses on `/`, `/ws`, `/gateway`, so the endpoint is path-agnostic.

Pairing was deliberately not completed: the only running instance is the shared `my-assistant` sandbox, and `device.pair.approve` is a write with reputational impact against shared infrastructure. By this document's own taxonomy that needs a recorded decision, and proving a protocol does not justify one.

### 14.2 Risk register

| # | Risk | Status | Mitigation |
|---|---|---|---|
| R1 | Telegram policy preset | **Resolved** | Ships in the CLI channel registry; hardened variant in `policies/omoda-telegram.yaml` |
| R2 | HERMES selectable | **Resolved** | `supportedAgents: ["openclaw","hermes"]`, Hermes installed on box |
| R3 | Port block unknown | **Resolved** | 3100 to 3199, all free, compiled into the Broker as a prohibited-list rule |
| R7 | Rules unread | **Resolved** | Read via Coda mirror. Track is Do; bounty is Best Use of NVIDIA Nemotron |
| A1 | Gateway protocol mismatch | **Resolved** | Verified §14.1 |
| R8 | Stock Telegram preset too broad | Open | Hardened preset excludes `setWebhook`; verified by asserting 403 |
| **R9** | **Problem-fit exposure.** Judging weighs whether the agent does something a human would otherwise do manually and warns that superficial framing scores low | **Open, decide Friday** | Run the §18.4 benchmark on an outward-facing task with a named beneficiary, not on OMODA's own codebase |
| A2 | Revert latency leaves a write window open | Open | Time-box every delta; failed revert halts the Broker as an incident |
| A3 | `impact` is declared, not proven | Open | Undeclared tools denied; manifest changes reviewed; verb derived from the call, not the manifest |
| A4 | Paperclip is large to stand up in a weekend | Open | `npx paperclipai onboard --yes`, self-hosted Postgres. Timebox to Friday evening; Layer 2 still demonstrates against a single agent if it does not come up |
| R4 | Shared vLLM contention | Mitigated | Bounded concurrency, memory floor, prohibited-list on `:8000` |
| R5 | AINative reachability | Mitigated | Offline-first; local WAL authoritative for the demo |
| R6 | Hosted Lightning unreachable | Mitigated | Planner falls back to Omni with a recorded caveat |

---

## 15. Hackathon Compliance

All code written during the event; only open-source dependencies whose **pinned version** was published on or before **2026-08-01**.

| Dependency | License | Public since | Pin | Verdict |
|---|---|---|---|---|
| **Paperclip** | MIT | repo **2026-03-02** | release on or before 2026-08-01 | OK |
| **NVIDIA NemoClaw** | Apache-2.0 | repo 2026-03-15 | `v0.0.90` | OK |
| **NVIDIA OpenShell** | Apache-2.0 | repo 2026-02-24 | `0.0.85` | OK |
| **Nemotron 3 Nano Omni** | NVIDIA open model | 2026-04-29 | NVFP4 build on box | OK |
| **Nemotron 3.5 Lightning** | Hosted endpoint | GA pre-event | `nemotron-3.5-lightning-30b-a3b` | OK, hosted service not vendored code |
| `ainative-zerodb-memory-mcp` | MIT | repo 2026-03-01 | **pin `1.2.6`**, not `1.2.7` (2026-08-01, on the boundary) | OK with pin |
| `zerodb-local` | **no declared license** | n/a | n/a | **Do not use.** ZeroDB HTTP client instead |
| `zod`, `node:test` | MIT / Node core | long-standing | n/a | OK |

`scripts/compliance-check.mjs` resolves license and publish date for every pinned dependency in CI and fails the build on any violation, so it breaks the build instead of relying on us to remember.

---

## 16. Data Model

Ownership is split, deliberately.

**Paperclip owns** (we read, we do not duplicate): agents, org chart, issues and tasks, `executionPolicy`, `executionState`, `issue_execution_decisions`, budgets, runs, skills catalog.

**OMODA owns:**

**`omoda_actions`**, append-only and hash-chained, local WAL mirrored to ZeroDB.

| Field | Notes |
|---|---|
| `action_id` | uuid, primary key |
| `seq`, `prev_hash`, `hash` | SHA-256 chain over the canonicalized record |
| `agent`, `tool`, `args_hash` | args hashed, never stored raw |
| `verb` | read / create / update / delete, derived from the call |
| `impact` | array, from the manifest |
| `envelope_refs` | which policy entries authorized it |
| `authority` | `envelope` / `decision:<paperclip_decision_id>` / `denied` / `prohibited` |
| `paperclip_issue_id`, `paperclip_decision_id` | cross-reference to the consent record |
| `inverse_ref` | compensating action, required for any update or delete |
| `delta_applied`, `delta_reverted_at` | approval-scoped capability lifecycle |
| `model`, `egress` | model used; `none`, `local`, or `hosted` |
| `outcome`, `latency_ms`, `trace_id` | result and OTLP correlation |
| `created_at`, `synced_at` | sync lag observable |

**`omoda_policy_registry`:** the compiled artifacts. `skill`, `manifest_hash`, `openshell_fragment`, `execution_policy`, `compiled_at`, `applied_at`, `active`.

**ZeroMemory:** operator preferences, prior decisions, Context Graph edges task to action to decision to skill.

---

## 17. API Endpoints

**AINative** (verified against the live catalog):

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/public/memory/v2/remember` | Operator preferences, prior decisions |
| POST | `/api/v1/public/memory/v2/recall` | Pre-task context and precedent |
| POST | `/api/v1/public/memory/v2/reflect` | Periodic consolidation |
| POST | `/api/v1/public/memory/v2/relate` | Context Graph edges |
| POST | `/api/v1/public/memory/v2/plan/create` · `/plan/update` | Reasoning chain per task |
| POST/GET | `/api/v1/zerodb/...tables/omoda_actions/rows` | Action ledger |
| POST/GET | `/api/v1/zerodb/...tables/omoda_policy_registry/rows` | Compiled policy registry |
| POST | `/api/v1/zerodb/...vectors/search` | Semantic search over prior decisions |

**Paperclip** (self-hosted, `:3100`):

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/companies/{id}/issues` | Create an issue carrying a compiled `executionPolicy` |
| PATCH | `/api/issues/{id}` | Record a decision: status plus the required comment |
| GET | `/api/agents/me` | Identity and company context |

**External, via the OpenShell gateway:**

| Endpoint | Purpose |
|---|---|
| `ws://127.0.0.1:18789` | OpenClaw gateway, protocol v4 |
| `https://integrate.api.nvidia.com/v1/chat/completions` | Nemotron 3.5 Lightning, planner |
| `http://host.openshell.internal:8000/v1/chat/completions` | Local Omni, perception and classification |
| `https://api.telegram.org/bot<token>/*` | Operator channel, token gateway-held |
| `nemoclaw` / `openshell` CLI | Policy read and delta application |

---

## 18. Test Plan

TDD. The safety negatives are written first, before the Broker exists. Target 80% or better on Compiler, Broker and Ledger.

### 18.1 Safety negatives (P0, must be red before any Broker code)

- Every prohibited-list item in §9.5 is refused **with a valid recorded decision present**, proving no decision path exists.
- **A consequential write is refused with 403 by OpenShell before the Broker is even consulted**, proving the capability is absent rather than merely gated.
- A proposed delta that would disable `managed_inference`, add an inference host directly, disable device auth, or apply `personal-open-internet` is refused at proposal time.
- An undeclared tool has no egress entry and no filesystem grant, and fails at Layer 3.
- A write with a non-empty `impact` and **no** matching `issue_execution_decisions` row never executes.
- A decision that is expired, spent, from the original executor, or missing its comment is rejected as forged.
- An update or delete with no registered inverse is refused, not downgraded.
- A bind outside 3100 to 3199 is refused.
- **Telegram hardening holds:** `POST /bot*/setWebhook` from inside the sandbox returns **403**. Same for `deleteMessage` and `sendDocument`. A non-403 means `protocol: rest` is not in effect and the envelope is not what the policy claims. Build-breaking, not a warning.
- Fail-closed: envelope read error, ledger write error, classifier timeout, and **failed revert** each refuse or halt.

### 18.2 Unit

- Compiler: manifest to OpenShell fragment and `executionPolicy`, golden-file per fixture; read compiles to `[GET]`; write with impact compiles to `read-only`.
- Recompilation after a manifest change yields the changed envelope, and the Broker re-reads rather than caching.
- Classification matrix across verb by impact by envelope.
- Compensating actions: file snapshot and restore, git ref save and reset, branch delete, each verified by post-restore hash equality.
- Ledger hash-chain integrity; tamper detection on a mutated middle record.
- Delta lifecycle: apply, retry, revert, and revert-on-expiry, each asserted against a re-read envelope.
- Model routing: sensitive payload never hosted; multimodal always Omni; Lightning to Omni fallback recorded.

### 18.3 Integration (on the box)

- Paperclip drives an agent through `openclaw_gateway`, end to end, including device pairing against **our own** sandbox.
- Consequential write: 403, stage opened, Telegram notice, decision recorded in Paperclip, delta applied, action retried and succeeds, delta reverted, ledger cites the decision id.
- Denial path: no delta applied, capability still absent, no re-escalation in session.
- `HALT` reverts all outstanding deltas within 2 s.
- WAL to ZeroDB sync: at-least-once, idempotent on `action_id`, correct across a simulated partition.

### 18.4 Benchmark (the G1 measurement and the demo)

One fixed, non-trivial, **outward-facing** task run twice: per-action-gated control versus OMODA, counting human decisions and wall-clock in each.

The task is chosen Friday against R9. It must have a named beneficiary and be something a person would otherwise do by hand, not maintenance on OMODA itself. The control run should need roughly 30 to 50 decisions; the target under OMODA is **3 or fewer**, and those should be exactly the consequential writes.

That delta is the whole claim, and this is the experiment that settles it. **We report the number either way.**

---

## 19. Security Considerations

- **Consent is a capability, not a convention.** The write method is absent from policy until a verified decision exists. This is the difference from both prior systems.
- **Containment is enforced, not requested:** Landlock, deny-by-default L7 egress, dropped capabilities, credential brokering. The model is untrusted by design.
- **No credential ever enters the sandbox.** NVIDIA, Telegram, Paperclip and AINative keys live gateway-side. A fully compromised agent has no key to exfiltrate, which is what makes unattended operation defensible.
- **The self-protection clause (§9.5 item 6)** stops the consent path becoming a privilege-escalation ladder. Highest-severity rule in the codebase.
- **Decision forgery** is the new attack surface this design introduces. Mitigated by verifying every decision against Paperclip's own `issue_execution_decisions` row, single-use binding to one `action_id`, TTL, and excluding the original executor.
- **Manifest integrity.** `impact` is a declaration. Manifest changes are reviewed, undeclared tools are denied, and the verb is derived from the call rather than trusted.
- **Least privilege per sub-agent.** Scout cannot write outside scratch; Perceiver has no egress; Operator cannot touch shared resources under any decision.
- **Prompt injection.** Fetched content is screened by the guard model before entering planner context. An injected instruction still has to pass the Broker, which does not read prompts, and then OpenShell, which does not either.
- **Audit integrity.** Hash-chained append-only ledger, args stored as hashes, written before execution, cross-referenced to Paperclip decisions.
- **Blast-radius honesty.** The demo states what OpenShell does not guarantee: `capsh` capability dropping is best-effort, and Landlock is best-effort on some kernels. Autonomy is scoped to what is actually enforced, and §9.5 hard-denies the rest.

---

## 20. Rollback Plan

- **`HALT`:** refuse-all within 2 s, all outstanding deltas reverted immediately.
- **`UNDO <token>`:** per-action reversal via the registered inverse, hash-verified.
- **Session rollback:** replay inverses in reverse `seq` order.
- **Policy rollback:** every applied delta is recorded with its inverse; policy is hot-reloadable, so revert takes seconds.
- **Skill disable:** removes the compiled fragment and narrows the envelope immediately.
- **Sandbox rebuild:** `nemoclaw omoda rebuild` returns to the blueprint image. In-session pairing and approvals do not persist, so a rebuild is a full authority reset. Skills survive via ZeroMemory promotion. Knowledge persists, authority does not.
- **Full stop:** `nemoclaw omoda stop`. Paperclip, the host vLLM, and the sibling project are unaffected by construction.

---

## 21. Timeline

Build window Fri evening 2026-08-14 to Sun 11:00 2026-08-16. Sunday 11:00 is a full **code freeze and submission deadline** via the Airtable form, following the published Demo Video Instructions and Submission Checklist. Judging 11:30 to 13:00, awards 14:00 to 15:00.

| Phase | Window | Work | Exit criteria |
|---|---|---|---|
| **P0: Foundations** | Fri PM | Stand up Paperclip on `:3100`. Create the `omoda` sandbox, pair a device against **our own** gateway. Decide the R9 benchmark task. Write §18.1 negatives first | Paperclip drives one agent through `openclaw_gateway`; benchmark task chosen; negatives red |
| **P1: Compiler** | Sat AM | `omoda.skill.yaml` schema, Compiler emitting both artifacts, capability registry generation | A skill enable produces a correct envelope and `executionPolicy`, proven by golden files |
| **P2: Broker + consent** | Sat PM | Classification, inverse registry, 403 interception, stage opening, decision verification, delta apply and revert | **A consequential write is 403, approved in Paperclip, retried, and reverted.** The money shot |
| **P3: Agents + models** | Sat PM/eve | Four sub-agents with narrowed envelopes, Lightning planner via gateway, Omni perception and classifier, sensitivity routing | Two models load-bearing with per-role call counts; third if memory allows |
| **P4: Telegram + ledger** | Sat eve | Escalation, one-tap decision written back to Paperclip, `UNDO`, `AUDIT`, `HALT`, ZeroDB sync | US-5 and US-10 demonstrated from a phone |
| **P5: Benchmark** | Sun AM | Run §18.4 both ways, record the number. Coverage 80%. Compliance check green | **G1 measured and reported honestly** |
| **P6: Submission** | Sun by 11:00 | Demo video, Airtable form, checklist | Submitted on time |

**Scope discipline.** P0 to P2 are the thesis. Not negotiable. The cut list, in order: the third model, GraphRAG depth, the Scout agent, ZeroDB sync (local WAL alone is sufficient for the demo).

---

## 22. Open Questions

1. **R9, the benchmark task.** Needs a named beneficiary and a task a person would otherwise do by hand. Blocking for P0 because everything else demonstrates against it.
2. **Paperclip stand-up risk.** If it does not come up Friday evening, do we push through or fall back to Layer 2 against a single Hermes agent? Recommendation: timebox to two hours, then fall back and say so in the demo.
3. **Device pairing versus disabling device auth.** Pairing properly is the better story and the adapter automates it. `OPENCLAW_DISABLE_DEVICE_AUTH=1` on loopback is the faster path. Recommendation: attempt pairing, fall back if it costs more than 30 minutes.
4. **Nemotron bounty framing.** The bounty is Best Use of NVIDIA Nemotron, broader than Lightning alone, with published criteria worth reading before Saturday. We run two Nemotron models in load-bearing roles, one local and one hosted. Open question is whether routing Lightning through the gateway rather than locally weakens the claim. Local is physically impossible at about 6 GiB free. Worth two minutes with an NVIDIA rep on site.
5. **Third model.** Ship the guard model or fold the role into Omni? Attempt at boot, fall back automatically, report what actually ran. Never claim three if two ran.
6. **Delta TTL.** How long should an approval-scoped write window stay open? Long enough for a retry with backoff, short enough that a crashed Broker cannot leave it open. Starting point 120 s, revisit after P2.
7. **Two-person rule scope.** Currently proposed for deletes with financial or legal impact. Is that too narrow, or too slow for a weekend demo with one operator?
8. **Team composition.** The rules require teams of 3 or more. Roster and role split (Compiler / Broker+consent / demo+benchmark) confirmed Friday.
