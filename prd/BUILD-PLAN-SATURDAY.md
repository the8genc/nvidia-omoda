# Saturday Build Plan: 09:00 to 20:00

**Date:** Saturday 2026-08-15 · **Written:** 09:09 PDT · **Hard stop:** 20:00
**Remaining:** 10.8 hours of build, then the evening is for the See integration spec.
**Submission:** Sunday 11:00, code freeze plus Airtable form.

This supersedes the timeline in §21 of the PRD. Friday is gone; everything compresses into today.

---

## 1. R9 is resolved: the See project is the benchmark

R9 said our benchmark task was engineering-internal and self-referential, which the judging criteria penalise. The two-project split solves it.

**See perceives the physical world. Do acts on it.**

A camera detects a real event. That detection requires a multi-step response that a person would otherwise perform by hand: check context, look up the relevant record, notify the right party, file the report, update the system of record. That is exactly what the Do track asks for, and it has a named beneficiary rather than a codebase.

| Judging criterion | How this answers it |
|---|---|
| Does the agent accomplish something a human would otherwise do manually? | Yes. A person currently watches a feed, notices an event, and then performs a five to ten step response |
| Problem fit, specific rather than superficial | The event class comes from See's actual detector, not a hypothetical |
| Technical depth, branching and error recovery | Detection to plan to governed execution, with consent branching on impact |
| The Spark story | Perception and policy classification both run locally on the GB10; nothing about the incident leaves the box |

**Benchmark task, to be finalised the moment See names its detector:** one detected event driving a complete response, run twice, per-action-gated control versus OMODA, counting human decisions. Control should need 30 to 50; target is 3 or fewer.

---

## 2. Four strategic calls

### Call 1: Invert P0. Build Layer 2 and 3 first. Paperclip becomes an optional client.

The thesis lives in Layer 2. Paperclip stand-up is a large TypeScript monorepo plus Postgres on ARM64 and is the single biggest schedule risk we have. If it eats four hours and fails, we have nothing to show.

So: build the Compiler, Broker and consent loop against our own Action API today. Paperclip integration is upside, attempted only if we are ahead at 16:00. The A1 handshake is already verified, so the integration story is credible in the writeup whether or not we wire it today.

### Call 2: The Action API is the primary interface. Telegram is one client of it.

We need programmatic access anyway, for See and for anything after the hackathon. Making the API the intake, rather than Telegram, removes the dependency on any single channel and makes the platform genuinely embeddable. Telegram becomes a client, See becomes a client, Paperclip becomes a client.

This is better design and lower risk at the same time, which is rare enough to take.

### Call 3: See is an untrusted input source. It may propose, never consent.

This is the security keystone, and it is not paranoia. A computer vision detector is an input channel an adversary can reach **by placing an object in front of a camera**. Treat a detection exactly like fetched web content: useful, unauthenticated as to intent, never authoritative.

Therefore the See service token carries `intent:propose` and nothing else. A spoofed or hallucinated detection can, at worst, open an intent that a human must consent to before anything consequential happens. It can never authorize its own real-world action.

### Call 4: Ship two agents, not four. Ship two models, not three.

Cut Scout and Comms as separate agents; fold their tools into Operator. Cut the guard model; the box does not have memory for it. Two Nemotron models in load-bearing roles is the honest claim.

---

## 3. The hour-by-hour

Each block has an exit test. If a block misses its exit, cut from §6 rather than borrowing from the next block.

| Time | Block | Exit test |
|---|---|---|
| **09:15 to 10:00** | Scaffold: repo layout, TypeScript, `zod` schemas, `node:test`. Write §5 safety negatives **first**, all red | Negatives run and fail for the right reasons |
| **10:00 to 11:30** | **Compiler.** `omoda.skill.yaml` schema, emit OpenShell policy fragment. Read compiles to `[GET]`; write with non-empty `impact` compiles to `read-only` | Golden-file test: one manifest in, correct fragment out |
| **11:30 to 13:00** | **Broker classification + Ledger.** Verb from the call, impact from the manifest, prohibited list, hash-chained WAL fsynced before execute | Classification matrix green; ledger tamper test passes |
| **13:00 to 15:00** | **The consent loop.** 403 interception, intent escalation, decision verification, scoped time-boxed delta, retry, guaranteed revert | **A consequential write is 403, consented, retried, reverted.** This is the demo. Nothing else matters as much |
| **15:00 to 16:15** | **Action API + stream ingress.** Six endpoints (§4), auth, signing, idempotency, rate limit. WebSocket consumer (§4a) as an adapter over the same pipeline | `curl` proposes an intent, decision flips it, ledger shows both. A streamed event dedupes and produces one intent |
| **16:15 to 17:00** | **Telegram client** on top of the API. Escalation, one-tap decide, `AUDIT`, `HALT`. First to go if the stream work runs long | Decide from a phone, end to end |
| **17:00 to 18:00** | **Benchmark.** Run the See-derived task both ways, record the number. Coverage check | G1 measured. Number recorded either way |
| **18:00 to 19:00** | Demo rehearsal on the box. Fix only what breaks the demo | Clean run twice in a row |
| **19:00 to 20:00** | Freeze. Write the See integration contract (§6) into `docs/` | Contract handed to the See team |

**If ahead at 16:00:** attempt Paperclip on `:3100` and wire `openclaw_gateway`. **If behind at 15:00:** cut the Telegram client and demo consent over the API with `curl`. The thesis survives; the polish does not.

---

## 4. The Action API

Bound to `127.0.0.1:3110` and the tailnet address only, inside our 3100 to 3199 block. No public ingress.

| Method | Path | Scope | Purpose |
|---|---|---|---|
| POST | `/v1/intents` | `intent:propose` | Propose work. Idempotent. Returns `intent_id` |
| GET | `/v1/intents/{id}` | `intent:read` | Status, plan, pending consent, outcome |
| POST | `/v1/intents/{id}/decisions` | `intent:decide` | Record consent. Verdict plus required reason |
| GET | `/v1/ledger` | `ledger:read` | Audit query, filterable by time, agent, verb, impact |
| POST | `/v1/halt` | `control:halt` | Kill switch. Reverts all outstanding deltas |
| GET | `/healthz` | none | Liveness |

**Propose, from the See project:**

```http
POST /v1/intents
Authorization: Bearer <see-service-token>        # scope: intent:propose ONLY
Idempotency-Key: det-2026-08-15T17:04:11Z-cam3-0447
X-OMODA-Timestamp: 1786807750
X-OMODA-Signature: sha256=<hmac over timestamp + body>

{
  "source": "see",
  "kind": "detection",
  "detector": "<named by the See team>",
  "confidence": 0.91,
  "observed_at": "2026-08-15T17:04:11Z",
  "evidence": { "frame_ref": "…", "camera": "cam3" },
  "requested_outcome": "run the standard response for this event class"
}
```

Response is `202 Accepted` with an `intent_id`. **Never `200 Executed`.** Proposing is not doing.

**Consent, from a human:**

```http
POST /v1/intents/{id}/decisions
Authorization: Bearer <operator-token>           # scope: intent:decide

{ "verdict": "approve", "reason": "confirmed on the live feed", "action_id": "…" }
```

The `action_id` binds the decision to one specific pending action, so a decision cannot be replayed against a different one.

---

## 4a. Stream ingress: consuming a WebSocket feed

A partner needs the platform to consume a WebSocket data stream, not just discrete HTTP calls. This fits, but the direction matters more than it looks.

### Prefer inbound. We serve, producers connect.

**`wss://<tailnet>:3111/v1/stream`**, producers dial us.

This is not a preference, it is a containment decision. An **outbound** WebSocket from the sandbox needs an OpenShell egress entry, and a WebSocket cannot be inspected as HTTP, so that entry has to be a raw L4 tunnel (`access: full`, `tls: skip`). NemoClaw's own presets do exactly this for WhatsApp and for the gateway dial-back, with comments saying so. **An L4 tunnel has no per-request method or path filtering**, which means the verb-level control in §8 of the PRD does not apply to it. Every byte is opaque.

Serving inbound needs no egress entry at all. The envelope does not widen, and we authenticate at accept time where we have full control.

### If we must dial out, isolate the tunnel

If the producer can only serve, put the dialing in a **separate collector process with its own minimal envelope**: the one L4 egress entry, no filesystem write beyond a scratch path, no other tools, no model access. Its only output is a call to the local Action API.

The unfiltered tunnel then exists inside a component whose entire capability is "read bytes, validate, POST to localhost". The blast radius of the thing we cannot inspect is a process that can do nothing else.

### Message envelope

Per-message, because HTTP headers are not available per frame:

```json
{
  "event_id": "cam3-1786807750-0447",
  "ts": 1786807750,
  "sig": "sha256=<hmac over event_id + ts + payload>",
  "payload": { "kind": "detection", "detector": "…", "confidence": 0.91, "evidence": {} }
}
```

- `event_id` replaces `Idempotency-Key`. Producer-assigned, unique, and the dedupe key.
- `ts` plus `sig` give the same replay window and tamper protection as S3, per message.
- The socket authenticates once at accept with a scoped token; **`intent:propose` only**, exactly as in Call 3. A stream is still an untrusted input source.

### Backpressure is a safety control, not an optimisation

A vision pipeline can emit detections continuously. One intent per message would flood the queue and the shared vLLM, which is a §14.2 R4 risk.

- **Dedupe** on `event_id`, then on a content hash within a time window.
- **Debounce** per `(detector, camera, class)`: collapse repeats inside a configurable window into one intent with an occurrence count.
- **Bounded queue with explicit shed.** When full, drop and **record the drop in the ledger**. A silently dropped detection is worse than a logged one.
- **Cap concurrent intents** derived from the stream, separately from API-derived intents, so a noisy feed cannot starve a human request.

### Cost

About 45 minutes, because it is an adapter over the same intent pipeline rather than a second path. It goes in the 15:00 block alongside the API. If it slips, it takes the Telegram client's slot, since Telegram is already cut list item 7 and the partner dependency is real.

---

## 5. Security hardening

Controls, each with the failure it prevents. All are enforced in the service layer and covered by a negative test.

| # | Control | Prevents |
|---|---|---|
| S1 | **Scoped bearer tokens.** `intent:propose`, `intent:read`, `intent:decide`, `ledger:read`, `control:halt`. One token, one scope set | A detector authorizing its own real-world action |
| S2 | **Separation of duties, enforced.** The identity that proposed an intent cannot record its decision. Mirrors Paperclip's exclude-the-executor rule | Self-approval, the most likely real bug |
| S3 | **HMAC request signing.** `X-OMODA-Signature` over timestamp plus raw body, 300 s window, nonce cache | Replay of a captured detection; tampering in transit on the tailnet |
| S4 | **Mandatory `Idempotency-Key` on propose.** Same key returns the same `intent_id`, never a second execution | A retrying detector firing the same response twice |
| S5 | **Strict schema, unknown fields rejected.** `zod` with `.strict()` | Parameter smuggling into downstream tool calls |
| S6 | **Per-token rate limit and concurrency cap** | A wedged detector flooding the queue or the shared vLLM |
| S7 | **Decisions verified against their own record**, single-use, TTL-bounded, bound to one `action_id` | Decision forgery, the attack this architecture introduces |
| S8 | **Evidence is untrusted.** Detection payloads are screened before entering planner context and never interpolated into a shell command or a policy path | Prompt injection through the physical world |
| S9 | **Undeclared is denied.** No manifest entry means no egress and no filesystem grant | Capability drift as skills are added under time pressure |
| S10 | **Credentials gateway-brokered.** Nothing in the sandbox, nothing in the repo, nothing in a log | Exfiltration by a compromised agent |
| S11 | **Bind to the port block and the tailnet only.** No `0.0.0.0`, no public ingress | Exposing the control plane of an agent platform |
| S12 | **Every API call ledgered with caller identity**, before execution, hash-chained | An action with no attributable origin |
| S13 | **Fail closed everywhere.** Classification error, policy read failure, ledger write failure, failed revert: refuse and halt | Silent degradation into ungoverned execution |

**Secrets handling for today:** no token in a commit, in a prompt, or in a screenshot during the demo. Generate service tokens at boot, print once, store in the gateway. Rotate before the demo video is recorded.

---

## 6. See to Do integration contract

The single interface the See team needs. Everything else about our internals is ours to change.

**They call one endpoint.** `POST /v1/intents` with the payload in §4, signed, idempotent, using a token we issue with `intent:propose` only.

**What they must provide, and it is the only thing we need from them tonight:**

1. The **detector name** and the **event classes** it emits.
2. For each class, the **response a human performs today**, step by step. This is what we automate and what the benchmark counts.
3. An **evidence reference** we can attach to the ledger. A frame path or object key is enough; we do not need the pixels.

**What they get back:** `202` with an `intent_id`, and `GET /v1/intents/{id}` for status. Optionally a webhook when the intent completes, signed the same way.

**What they never get:** the ability to consent. If a response step is consequential, a human decides, and the ledger records who.

**Degraded mode:** if the API is not up when See is ready to test, they post the same JSON body to the Telegram bot and we bridge it. The contract is the payload, not the transport.

---

## 7. Cut list, in order

Cut from the top when a block misses its exit test. Do not negotiate mid-block.

1. Paperclip integration (already optional; the A1 proof carries the story)
2. ZeroDB and ZeroMemory sync (local WAL is sufficient for the demo)
3. The third model (memory-gated, will not fit)
4. Scout and Comms as separate agents (fold into Operator)
5. Sequential Thinking plan artifacts
6. Skills promotion and rebuild survival
7. The Telegram client (demo consent over the API with `curl`)
7a. Outbound stream dialing, if the producer can serve instead. Inbound costs us nothing and widens nothing
8. The web view of the ledger (`GET /v1/ledger` returning JSON is enough)

**Never cut:** the safety negatives, the 403 interception, the scoped delta and its revert, the ledger. Those are the thesis. A demo without them is a slide deck.

---

## 8. What we hand over at 20:00

- Working consent loop, demonstrable twice in a row.
- Action API with the six endpoints and S1 through S13.
- WebSocket stream ingress, inbound, with dedupe and bounded shed.
- The benchmark number, whatever it is.
- This integration contract, delivered to the See team.
- A written note on what was cut and why, so the demo video does not overclaim.
