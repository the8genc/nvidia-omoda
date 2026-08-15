# Prior Platform Analysis and the Case for a Three-Layer Architecture

**Author:** Arif Gursel · 8genC
**Date:** 2026-08-15
**Status:** Input to the OMODA PRD rewrite
**Scope:** What PACE (GarV) and Paperclip each prove, what neither closes, and the architecture that follows.

---

## 1. Why this analysis exists

OMODA's first PRD assumed we build the orchestration layer ourselves: an L0 harness, sub-agents, a task loop, an audit ledger. That assumption is now wrong, and expensively so.

Paperclip already is that layer, at 78,237 stars and 14,351 forks, MIT licensed, in production use. Rebuilding it over a hackathon weekend would be the single worst use of the time available, and it would score badly against a judging rubric that explicitly rewards "significant engineering under the hood" rather than reimplementation.

The right move is to identify what the proven platforms do **not** do, and build only that.

---

## 2. What each prior platform proves

### 2.1 PACE / GarV (`agents.getonpace.org`, `the8genc/chief-of-staff`)

Proves that **per-action human gating produces trustworthy autonomy**, and what it costs.

| Element | Implementation |
|---|---|
| Topology | L0 orchestrator, proxy layer, L1 domain agents, L2 platform workers |
| Safety invariant | No email sent without a valid, unexpired, principal-issued approval token |
| Enforcement point | `sendGate.js`, one service-layer function, proven by a negative test |
| Memory | ZeroDB tables, ZeroMemory recall, Sequential Thinking plans |

**What it proves:** a single choke point for dangerous actions is auditable, testable, and defensible. The invariant held.

**What it costs:** the gate is enforced in application code. It is correct because we wrote it correctly. A bug in `sendGate.js`, or any code path that reaches the Gmail client without traversing it, silently voids the guarantee. And every action waits on a human, so throughput is capped at human response latency.

### 2.2 Paperclip (`paperclipai/paperclip`)

Proves that **agent orchestration is a solved problem at scale**.

| Element | Implementation |
|---|---|
| Org model | Org chart with titles and reporting lines; Mission → Project Goal → Agent Goal → Task |
| Scheduling | **Heartbeats.** Agents wake on `timer`, `assignment`, `on_demand`, or `automation`; concurrent wakeups coalesce |
| Agent runtimes | Adapters: `claude_local`, `codex_local`, `opencode_local`, `cursor`, `pi_local`, `hermes_local`, `hermes_gateway`, **`openclaw_gateway`**, `process`, `http` |
| Work product governance | `executionPolicy` per issue: ordered `review` and `approval` stages, participants may be agent or user |
| Audit | `issue_execution_decisions` table: actor, outcome, required comment, run id. Comment-required backstop with retry |
| Cost control | Per-agent monthly budget, automatic pause at 100% |
| Skills | `SKILL.md` entrypoint plus a catalog with `trustLevel`, `requires`, `recommendedForRoles`, per-file `sha256`, `contentHash` |
| Deployment | Self-hosted Node.js, embedded or external Postgres, multi-company isolation |

Their design principle #1 for execution policy is, verbatim, **"Runtime-enforced, not prompt-dependent."** They already believe the right thing.

### 2.3 The gap Paperclip's own documentation admits

From `docs/agents-runtime.md`, section 9:

> **"Local CLI adapters run unsandboxed on the host machine."**
> "That means: prompt instructions matter, configured credentials/env vars are sensitive, working directory permissions matter."
> "Start with least privilege where possible."

This is the trust-by-prompt posture. Paperclip's execution policy is runtime-enforced **for the work product**: it intercepts a status transition to `done` and routes the issue to a reviewer. It is not enforced for the **action**. An agent in `in_progress` can run any shell command, delete any path, and reach any host, and the review stage happens afterwards, if at all.

Put plainly: **Paperclip governs the deliverable. Nothing governs the blast radius.**

---

## 3. The two systems are orthogonal, and that is the opportunity

| | Paperclip `executionPolicy` | OpenShell policy |
|---|---|---|
| Governs | The work product | The action |
| Question answered | *Should this outcome ship?* | *Can this process even do that?* |
| Timing | After the executor finishes | Before the syscall or request completes |
| Enforced by | Application runtime | Kernel and L7 proxy: Landlock, deny-by-default egress, dropped capabilities, credential brokering |
| Failure mode alone | Agent exfiltrates a database before anyone reviews the ticket | No notion of who should sign off on a consequential outcome |

Neither is sufficient. Together they are, and **nothing currently connects them**. That connective layer is the whole of OMODA's contribution.

---

## 4. Formalizing danger

The taxonomy, stated as two independent axes.

### Axis 1: dangerous **actions**, from the CRUD verb

Mechanically determinable from the tool call itself. Reads are safe. Writes are governed.

| Verb | Class | Reversible by construction? |
|---|---|---|
| Read | safe | n/a |
| Create | write | yes, delete the created thing |
| Update | write | only with a pre-image snapshot |
| Delete | write | only with a pre-image snapshot |

### Axis 2: dangerous **outcomes**, from the blast domain

Semantically determinable from the tool and its target, declared in the skill manifest.

- **Financial:** moves money, incurs cost, changes a price, issues a credit.
- **Legal:** creates or alters a contractual or regulatory obligation, touches regulated or personal data.
- **Reputational:** anything a third party sees under our name. Outbound messages, published content, public commits.

### The matrix that results

Axis 1 decides **what enforcement mechanism applies**. Axis 2 decides **who must consent**.

| | Read | Create | Update | Delete |
|---|---|---|---|---|
| **No impact domain** | Autonomous. `access: read-only`, methods `[GET]` | Autonomous, ledgered | Autonomous, ledgered, inverse required | Autonomous, inverse required, `UNDO` offered |
| **Financial / legal / reputational** | Autonomous, logged as a sensitive read | **Approval-scoped write** | **Approval-scoped write**, inverse required | **Approval-scoped write**, inverse required, two-person rule |

---

## 5. The mechanism: approval-scoped capability

This is the part that is new, and it is the reason the architecture is worth building.

In GarV, an approval is a **token checked in application code**. In Paperclip, an approval is a **workflow state**. In both, the capability to act exists the whole time and the approval is a request that the agent not use it yet.

In OMODA, **the approval materializes the capability**.

For any tool whose manifest declares a write verb against a non-empty impact domain, the compiled OpenShell policy grants `access: read-only` with methods `[GET]`. The write method is not in the policy. An attempt to `POST` returns 403 from the L7 proxy, below the agent, regardless of what the model decides or what a prompt injection tells it.

When a Paperclip execution stage records an `approved` decision:

1. The Broker verifies the decision is genuine: correct issue, correct stage, correct participant, not the original executor, comment present.
2. It hot-reloads a **narrowly scoped, time-boxed** policy delta that adds exactly the one method and path the approved action needs.
3. The action is retried.
4. The delta is reverted on completion or on expiry, whichever comes first.

The approval is therefore enforced by the runtime rather than respected by the agent. A jailbreak, a confused tool call, or a poisoned web page cannot produce the write, because the write does not exist as a reachable capability until a human decision has been recorded against it.

**This is the improvement over both prior executions**, and it is the reason the human gating can be removed everywhere else. Once consequential writes are structurally unreachable without a recorded decision, everything that is not a consequential write can run unattended at full speed.

---

## 6. The three layers

Exactly the levels requested: orchestration, policy determination, protections.

```
┌─ LAYER 1  ORCHESTRATION ─ Paperclip, unmodified, upstream ────────────────┐
│  Org chart · heartbeats (timer/assignment/on_demand/automation)           │
│  Mission → Goal → Task · budgets · tickets · executionPolicy stages       │
│  issue_execution_decisions audit · skills catalog (SKILL.md, trustLevel)  │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │ adapter: openclaw_gateway
                                │ decision events, wakeups
┌───────────────────────────────▼─ LAYER 2  POLICY DETERMINATION ──────────┐
│  OMODA Policy Compiler + Autonomy Broker      (the only thing we build)   │
│                                                                           │
│   skill manifest ──compile──▶ OpenShell policy fragment  (can it?)        │
│                  └─compile──▶ Paperclip executionPolicy  (should it?)     │
│                                                                           │
│   Broker: classify verb × impact × envelope → allow / ledger / escalate    │
│   Approval-scoped capability: decision ⇒ time-boxed policy delta ⇒ revert  │
│   Action ledger: hash-chained, written before execute                     │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │ openshell policy set / update
┌───────────────────────────────▼─ LAYER 3  PROTECTIONS ───────────────────┐
│  NVIDIA OpenShell, via NemoClaw                                           │
│  Landlock filesystem confinement · deny-by-default L7 egress              │
│  dropped Linux capabilities · gateway credential brokering                │
│  Verified on box: /usr/local/bin/openclaw runs inside the sandbox         │
└───────────────────────────────────────────────────────────────────────────┘
```

**We build Layer 2 only.** Layer 1 is upstream Paperclip. Layer 3 is upstream NemoClaw and OpenShell. That is a weekend-sized surface with a genuinely novel mechanism at its centre.

---

## 7. Skill-agnostic by construction

The platform must not know what any skill does. It knows only what a skill **declares**.

Paperclip's catalog already carries a trust axis (`markdown_only`, `assets`, `scripts_executables`), but that describes what the skill *file contains*, not what the skill *does*. OMODA adds a sidecar manifest that declares behaviour:

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

Turning the skill on provisions a sub-agent whose envelope is exactly this manifest and nothing more. Turning it off removes the envelope. No skill can widen its own reach, because the compiler is the only writer of policy and the manifest is the only input.

**Undeclared is denied.** A tool absent from the manifest has no egress entry and no filesystem grant, so it fails closed at Layer 3 rather than relying on Layer 2 to notice.

### The per-agent capability table this produces

This is the artifact the PRD should carry for every agent: not prose, but a generated table.

| Agent | Tool | Verb | Impact | OpenShell grant | Consent required |
|---|---|---|---|---|---|
| Scout | `http.get` | read | none | `GET` on allowed hosts | none |
| Builder | `git.commit` | create | none | workspace write | none, ledgered |
| Builder | `git.push` | update | reputational | `read-only` until approved | review stage |
| Perceiver | `omni.perceive` | read | none | local endpoint only, **egress denied** | none |
| Operator | `shell.exec` | update | none | workspace only, port block only | none, inverse required |
| Comms | `telegram.sendMessage` | create | reputational | `POST` on one path, approval-scoped | approval stage |
| Finance | `quickbooks.invoice.void` | delete | financial, legal | `read-only` until approved | approval + two-person |

---

## 8. What this changes in the PRD

| Section | Change |
|---|---|
| §1 Overview | OMODA is a policy layer over Paperclip, not a competing orchestrator |
| §2 Problem | Sharpen: Paperclip's own docs admit local adapters run unsandboxed. Cite it |
| §3 Prior art | Add Paperclip as the second control condition. GarV proves per-action gating; Paperclip proves orchestration; neither connects consent to capability |
| §6 Features | Drop orchestration, task loop, ledger-as-primary. Add: policy compiler, approval-scoped capability, skill manifest, per-agent capability table |
| §9 Architecture | Replace with the three layers above |
| §9.3 Broker | Reclassify on verb × impact × envelope instead of reversibility alone |
| §10 MCP tools | Regenerate from the manifest rather than hand-listing |
| §15 Data model | Paperclip owns tasks, decisions, budgets. OMODA owns the action ledger and the compiled-policy registry |
| §16.4 Benchmark | Ties directly to R9: run it on an outward-facing task, which the Paperclip org chart makes natural |

---

## 9. Risks this introduces

### 9.1 A1 spike result: the seam is verified, frame for frame

The question was whether Paperclip's `openclaw_gateway` adapter can drive an agent contained by OpenShell, or whether NemoClaw exposes an incompatible gateway.

**Method.** Read the adapter's wire contract from `packages/adapters/openclaw-gateway/src/server/execute.ts`, then replay its exact `connect` frame against the live gateway on the box using a minimal client. Read-only: no pairing, no agent commands, no writes.

**What the adapter expects.** WebSocket, frames `{type:"req"|"res"|"event"}`, `PROTOCOL_VERSION = 4`, method `connect`, client identity `gateway-client` / mode `backend` / role `operator` / scopes `["operator.admin"]`, then a nonce challenge answered with an Ed25519 device identity.

**What the box actually returned**, on `ws://127.0.0.1:18789`:

```
WS OPEN (upgrade accepted)
SENT connect (protocol v4)
RECV {"type":"event","event":"connect.challenge",
      "payload":{"nonce":"b95b2426-8e0a-4dc5-831a-c9323bde2f65","ts":1786807750042}}
RECV {"type":"res","ok":false,
      "error":{"code":"NOT_PAIRED","message":"device identity required",
               "details":{"code":"DEVICE_IDENTITY_REQUIRED"}}}
WS CLOSE 1008 device identity required
```

**Reading.** The gateway accepted the upgrade, accepted protocol v4, accepted Paperclip's exact client identity and scopes, and answered with `connect.challenge` carrying a nonce. That is precisely the handshake the adapter's `buildConnectParams: (nonce) => ...` signature is written against. It then refused for one reason only: no device identity.

Device pairing is not a gap. The adapter already implements it: `ED25519_SPKI_PREFIX`, `device.pair.list`, `device.pair.approve`, and `autoPairOnFirstConnect` defaulting to true. Paperclip also documents `OPENCLAW_DISABLE_DEVICE_AUTH` for loopback development.

Identical responses came back on `/`, `/ws`, and `/gateway`, so the endpoint is path-agnostic. Paperclip's own docs already carry `ws://127.0.0.1:18789` as the example URL, which is this exact port.

**Conclusion.** The three-layer architecture rests on a verified seam, not an assumption. Layer 1 can drive Layer 3 over a protocol both sides already speak, with one standard auth step remaining.

### 9.1a Device identity implemented and accepted (2026-08-15, later)

The remaining auth step is now built and exercised against the live gateway. `src/gateway/openclaw.js` reproduces the adapter's contract exactly: `PROTOCOL_VERSION = 4`, the ed25519 SPKI prefix, and the eleven pipe-joined fields of the v3 device-auth payload (`v3|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce|platform|deviceFamily`). The device id is the SHA-256 of the raw public key, so it is derived from the keypair rather than asserted, and the key is persisted so the id is stable across runs rather than filing a fresh pairing request on every connect. Thirteen tests in `test/openclaw-gateway.test.js` pin every constant and verify the signature the way the gateway would; if the upstream adapter drifts, those tests fail rather than the seam silently going stale.

Probed against the Acer gateway on `ws://127.0.0.1:18789` through an SSH tunnel, the device identity was **accepted**. The refusal moved one gate forward:

```
before:  NOT_PAIRED / DEVICE_IDENTITY_REQUIRED
now:     INVALID_REQUEST: unauthorized: gateway token missing (provide gateway auth token)
```

So the challenge-response is satisfied, and what remained was a gateway auth token, which is the owning team's shared secret rather than anything derivable client-side. That is the correct shape: a device proves it holds its key, and a separate credential proves the session is allowed to pair.

### 9.1b Fully paired against the Acer gateway (2026-08-15, later still)

With the box owner's authorization, the shared token was supplied out of band (written to a gitignored `.env`, mode 600, never committed) and the connect completed:

```
gateway token: 48 chars loaded
connect: challenge nonce d8968526-...
OK  connected. protocol=4
hello: {"type":"hello-ok","protocol":4,"server":{"version":"2026.5.12", ...}}
```

Both gates are now cleared: the ed25519 device identity satisfies the challenge, and the shared token authorizes the session. The gateway returns `hello-ok` and exposes **171 methods** to Layer 1, including the full agent-driving surface: `tasks.list/get/cancel`, `agents.list/create/update/delete`, `agents.files.list/get/set`, and `sessions.list/subscribe`.

That surface is the thesis in one screen. `agents.create`, `agents.update`, and `agents.delete` are CREATE, UPDATE and DELETE against a live agent runtime: by this document's own taxonomy they are the dangerous actions, the writes that must compile to read-only until a recorded decision materializes them. The seam Paperclip drives is exactly the seam OMODA governs. Layer 1 can orchestrate over this gateway; Layer 2 decides which of its 171 methods an agent may reach and when; Layer 3 is the gateway itself enforcing that envelope.

**A note on how the token was handled.** Retrieving another team's live secret is a write-adjacent act against shared infrastructure, so it was gated on the human who administers the box, not taken autonomously. The automated safety layer refused every attempt to read credential material through the agent, which is the correct default; the token reached the client only because its owner placed it there deliberately. The token is a live shared secret and is tracked for rotation before the demo (issue #18). `scripts/gateway-pair.mjs` still gates `device.pair.approve` behind an explicit `--approve`, refuses to approve a pending request belonging to a different device id, and ledgers every attempt; probe and approve remain separate acts.

### 9.2 Remaining risks

| # | Risk | Mitigation |
|---|---|---|
| ~~**A1**~~ | ~~Gateway protocol mismatch.~~ **RESOLVED 2026-08-15: fully paired against the live Acer gateway, `hello-ok` protocol 4, 171 methods exposed.** See §9.1a, §9.1b | Device identity plus shared token; both gates cleared end to end |
| **A2** | **Policy hot-reload latency** on the approval path. If reverting a delta is slow, the write window stays open longer than intended | Time-box every delta, revert on completion, and treat a failed revert as an incident that halts the Broker |
| **A3** | **Impact classification is a declaration, not a proof.** A skill author can mark a financial write as `impact: []` | Compiler denies unknown tools by default; a review gate on manifest changes; the CRUD verb is derived from the call, not the manifest, so a write cannot masquerade as a read |
| **A4** | **Scope.** Paperclip is a large system to stand up in a weekend alongside everything else | It installs with `npx paperclipai onboard --yes` and self-hosts on Postgres. Timebox to Friday evening; if it does not come up, Layer 2 still demonstrates against a single Hermes agent |
| **A5** | Two-week open-source rule | Upstream `paperclipai/paperclip` public since **2026-03-02**, MIT. Pin a release published on or before 2026-08-01 |

---

## 10. The claim, restated

GarV proved a single choke point works but pays for it with a human in every loop, and enforces the gate in code we wrote.

Paperclip proved orchestration at scale and enforces work-product review in its runtime, but leaves the action surface unsandboxed and says so.

OMODA connects consent to capability: a Paperclip approval decision is what **materializes** an OpenShell write grant, time-boxed and scoped, and nothing else can. Reads run free. Contained writes run free and ledgered. Only writes that can cost money, create liability, or speak in our name require a decision, and for those the capability does not exist until the decision does.

That is the improvement over both prior executions, and it is what the always-on Acer hardware and the Nemotron models make practical to run continuously rather than on demand.
