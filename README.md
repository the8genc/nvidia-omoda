# OMODA

**An approval should not be a request that an agent behave. It should be the thing that creates the capability.**

NVIDIA Spark Hackathon, Seattle. **Track: Do.** Runs on the shared Acer Veriton GN100 (DGX Spark, `gn100-390c`), tailnet only.

Sibling project: [`the8genc/leftovers`](https://github.com/the8genc/leftovers) (See track, computer vision). See perceives the physical world; OMODA acts on it.

---

## The idea in one paragraph

Every agent platform holds dangerous capability open and asks the model not to use it yet. A system prompt is not a security boundary, and an approval checked in application code is only as good as the code. OMODA inverts this. Any action that can cost money, create legal liability, or speak in our name compiles to a policy that grants `GET` and nothing else, so the write method is **absent from the sandbox**. A recorded human decision is what materialises it, scoped to one method on one path and time boxed, and the runtime revokes it afterwards. Everything that is not such an action runs unattended at full speed.

Boot the platform with two skills enabled and it says:

```
  tools   9 declared; anything else is denied
  gated   5 require a recorded decision
  granted GET across every enabled skill
```

Nine tools, five of them consequential, and not one write method exists yet.

---

## Three layers, and we build one

| Layer | What | Whose |
|---|---|---|
| 1. Orchestration | Org chart, heartbeats, tasks, budgets, review stages | **Paperclip**, upstream, MIT, 78k stars |
| 2. Policy determination | **Compiler + Autonomy Broker** | **ours** |
| 3. Protections | Landlock, deny-by-default L7 egress, dropped caps, credential brokering | **NVIDIA OpenShell** via NemoClaw |

Paperclip governs the deliverable. Nothing governed the blast radius. Its own runtime doc says local adapters "run unsandboxed on the host machine". OMODA is the layer that makes a consent decision physically govern a capability.

The seam is verified, not assumed: replaying Paperclip's `openclaw_gateway` handshake against the box returned `connect.challenge` on protocol v4 and refused only on `DEVICE_IDENTITY_REQUIRED`. See `prd/ARCHITECTURE-ANALYSIS.md` section 9.1.

---

## Danger, as two axes

**The CRUD verb is derived from the call**, so it cannot be misdeclared. **The impact domain is declared per tool** in the manifest.

| | Read | Create | Update | Delete |
|---|---|---|---|---|
| **No impact** | autonomous, silent | autonomous, ledgered | autonomous, inverse required | autonomous, inverse + `UNDO` |
| **Financial / legal / reputational** | autonomous, logged | **consent** | **consent** + inverse | **consent** + inverse + two-person |

Reads are safe. Writes are governed. Writes that can produce a dangerous outcome are not merely governed, they are absent from policy until a decision exists.

---

## Run it

```bash
npm install
npm test            # 112 tests
npm run demo        # the whole narrative, end to end
npm start           # API, UI and stream ingress
npm run policy      # print the compiled envelope for every enabled skill
npm run compliance  # fail the build on any dependency outside the hackathon rule
```

`npm run demo` walks the full path: a camera proposes work it cannot authorise, an injection attempt in the evidence is redacted, the financial write is refused by policy, a human decision creates the capability, the capability is revoked, and the hash chain verifies.

---

## Skills are the only input

A skill is enabled by existing at `skills/<name>/omoda.skill.yaml`. The compiler is the only writer of policy, and the manifest is its only input, so a skill cannot widen its own reach.

```yaml
skill: incident-response
agent: responder
capabilities:
  - tool: roads.segment.lookup      # read: runs free
    verb: read
    impact: []
    egress: { host: roads.example.gov, path: "/api/segments/**" }

  - tool: incident.record.create    # write + legal: consent required
    verb: create
    impact: [legal]
    egress: { host: dispatch.example.gov, path: "/api/incidents" }
```

Compiles to an OpenShell fragment, a consent plan, and the capability registry the UI renders. **Undeclared is denied**: a tool absent from every manifest gets no egress entry and no filesystem grant, so it fails at layer 3 rather than relying on layer 2 to notice.

---

## Interfaces

The **Action API** is the intake. Telegram is a client of it, the See project is a client of it, Paperclip would be a client of it.

| | |
|---|---|
| `POST /v1/intents` | propose work. Returns **202**, never 200. Proposing is not doing |
| `POST /v1/intents/{id}/decisions` | record consent |
| `GET /v1/ledger` | the hash-chained audit trail |
| `POST /v1/halt` | kill switch; reverts every open capability |
| `ws://…:3111/v1/stream` | continuous detections, deduped and debounced |
| `/ui` | server-rendered React. No client bundle, no script tag |

Integration contract for the See team: [`docs/see-to-do-contract.md`](docs/see-to-do-contract.md).

---

## Security posture

Thirteen controls, each with a test that names the failure it prevents. The three that matter most:

**A perception feed may propose, never consent.** A detector is an input channel an adversary reaches by putting an object in front of a camera. Its token carries `intent:propose` and nothing else, and a decide-capable token is refused on the stream outright.

**Separation of duties is enforced in the store**, not left to callers. The identity that proposed an intent cannot record its decision.

**The self-protection clause.** The Broker's authority derives from OpenShell policy, so it refuses to broker any change that would dismantle OpenShell: disabling `managed_inference`, adding an inference host directly, disabling device auth, or applying `personal-open-internet`. Without it the consent path is a privilege escalation ladder.

Making consent materialise capability introduces one new attack, **decision forgery**, and we say so. It is mitigated by verifying every decision against its own record, binding it to a single `action_id`, single use, and a TTL.

---

## Models

Two Nemotron models in load-bearing roles, routed in the Broker rather than requested in a prompt.

| Role | Model | Where |
|---|---|---|
| Planner, tool calling | `nemotron-3.5-lightning-30b-a3b` | hosted, via the OpenShell gateway |
| Perception, risk classification | `Nemotron-3-Nano-Omni-30B-A3B-Reasoning-NVFP4` | local vLLM on `:8000` |

The box has about 6 GiB free, so a second 30B model physically cannot load. That is why the planner is hosted and the guard model is memory gated rather than assumed. Sensitive payloads never leave the box, and asking to send one is refused rather than silently downgraded, so the attempt lands in the ledger.

---

## Working on the box

```bash
ssh gn100                # as `arif`, never the shared acer01 login
source ~/env.sh          # PORT_BASE=3100, SPARK_LLM, SPARK_MODEL, OMODA_DIR
cd ~/omoda
```

Constraints that are shared, so they are not negotiable:

- **Memory is one pool and nearly full.** 121 GiB across CPU and GPU, about 115 in use. Run `spark-status.sh` before anything heavy. An OOM kill takes down the model server for both projects at once.
- **Our port block is 3100 to 3199.** The Broker treats a bind outside it as prohibited, with no consent path.
- **Never touch** `:8000`, `$HF_HOME`, the docker socket, or another team's block.
- **Branch per task**, `<yourname>/<feature>`. Keep `main` runnable.

---

## Documents

| | |
|---|---|
| [`prd/OMODA-PRD.md`](prd/OMODA-PRD.md) | the full PRD |
| [`prd/ARCHITECTURE-ANALYSIS.md`](prd/ARCHITECTURE-ANALYSIS.md) | why three layers, and what Paperclip and GarV each prove |
| [`prd/BUILD-PLAN-SATURDAY.md`](prd/BUILD-PLAN-SATURDAY.md) | the one-day plan and its cut list |
| [`docs/see-to-do-contract.md`](docs/see-to-do-contract.md) | integration contract for the See team |
| [`policies/omoda-telegram.yaml`](policies/omoda-telegram.yaml) | hardened Telegram egress, seven methods, no `setWebhook` |
