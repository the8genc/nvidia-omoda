# See to Do: integration contract

**For:** the `leftovers` (See track) team
**From:** OMODA (Do track)
**Status:** ready to build against. The API is implemented and tested; the endpoint goes live on the box today.

You send us detections. We turn them into governed action. This is everything you need and nothing about our internals that could change under you.

---

## 1. The shape of it

```
  camera ──▶ your detector ──▶ POST /v1/intents  (or the WebSocket)
                                      │
                                      ▼
                          OMODA plans and executes
                          safe reads run free
                          contained writes run free and ledgered
                          consequential writes wait for a human
```

**You may propose. You may never consent.** Your token carries `intent:propose` and nothing else.

That is not distrust of your code. A detector is an input channel an adversary can reach **by putting an object in front of a camera**. If a detection could authorize its own real-world action, then a printed sign becomes a way to move money. So a spoofed or hallucinated detection can, at worst, open an intent that a human must approve.

---

## 2. What we need from you (the only blocking item)

Three things, and the second one is the one that actually gates our benchmark:

1. **Detector name and its event classes.** For example `traffic-anomaly` emitting `stopped-vehicle`, `wrong-way`, `debris`.
2. **For each class, the response a person performs today, step by step.** Literally the manual runbook: who they call, what they look up, what they file, what they update. This is what we automate, and the step count is the control arm of our benchmark. Without it we have no measurement.
3. **An evidence reference** we can put in the audit ledger. A frame path, an object key, or a URL. **We do not need the pixels.**

Optional but useful: whether you can **serve** a WebSocket, or need us to connect to yours. See section 5.

---

## 3. HTTP: propose an intent

```
POST http://<omoda-host>:3110/v1/intents
Authorization: Bearer <the token we issue you>
Idempotency-Key: <unique per detection, e.g. cam3-1786807750-0447>
X-OMODA-Timestamp: <unix seconds>
X-OMODA-Signature: sha256=<hmac>
Content-Type: application/json

{
  "source": "see",
  "kind": "detection",
  "detector": "traffic-anomaly",
  "confidence": 0.94,
  "observed_at": "2026-08-15T17:04:11Z",
  "evidence": { "frame_ref": "s3://frames/cam3/1786807750.jpg", "camera": "cam3" },
  "requested_outcome": "run the standard response for a stopped vehicle"
}
```

**Response is always `202 Accepted`, never `200`:**

```json
{ "intent_id": "int_9f2c...", "state": "proposed", "duplicate": false }
```

202 is deliberate. Proposing is not doing. If you ever see a 200 from this endpoint, something is wrong with our side and you should tell us.

### The signature

HMAC-SHA256 over `` `${timestamp}.${rawBody}` `` using the secret we issue alongside your token.

```js
import { createHmac } from "node:crypto";

const body = JSON.stringify(payload);            // sign the EXACT bytes you send
const ts = Math.floor(Date.now() / 1000);
const sig = "sha256=" + createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex");

await fetch(`${OMODA}/v1/intents`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${TOKEN}`,
    "idempotency-key": eventId,
    "x-omoda-timestamp": String(ts),
    "x-omoda-signature": sig,
    "content-type": "application/json",
  },
  body,
});
```

Sign the same string you put on the wire. Re-serialising between signing and sending is the usual way this breaks.

### Idempotency

`Idempotency-Key` is **mandatory**. Send the same key for a retry of the same detection and you get the same `intent_id` back with `"duplicate": true`. Your retry logic cannot accidentally fire the response twice.

### Errors you might actually hit

| Status | Meaning | What to do |
|---|---|---|
| 400 `idempotency_required` | No `Idempotency-Key` | Add one, unique per detection |
| 401 `stale` | Timestamp outside 300s | Check clock skew |
| 401 `bad_signature` | HMAC mismatch | You signed different bytes than you sent |
| 409 `replay` | Same signature reused with a new key | Recompute the timestamp per request |
| 422 `schema` | Unknown or malformed field | We reject unknown fields on purpose |
| 429 `rate_limit` | Too fast | Back off; see section 5 on debounce |

---

## 4. Check on an intent

```
GET /v1/intents/{intent_id}
Authorization: Bearer <token>
```

Returns state, the actions we derived, any decisions recorded, and the outcome. States: `proposed`, `awaiting_consent`, `executed`, `refused`, `denied`.

If you would rather be told than poll, give us a URL and we will POST you a signed completion callback using the same signing scheme.

---

## 5. WebSocket: continuous feed

Preferred for anything higher than a few events a minute.

**We serve, you connect:** `ws://<omoda-host>:3111/v1/stream`, with `Authorization: Bearer <token>` on the upgrade.

We chose inbound deliberately. An outbound WebSocket from our sandbox would need a policy entry that cannot be inspected as HTTP, which means an unfiltered tunnel and the loss of the per-request control the whole system depends on. You connecting to us costs nothing. If you can only serve, tell us and we will run an isolated collector whose only capability is to read your stream and post to our own localhost.

One JSON message per event, because HTTP headers are not available per frame:

```json
{
  "event_id": "cam3-1786807750-0447",
  "ts": 1786807750,
  "sig": "sha256=<hmac over `${event_id}.${ts}.${JSON.stringify(payload)}`>",
  "payload": {
    "kind": "detection",
    "detector": "traffic-anomaly",
    "class": "stopped-vehicle",
    "camera": "cam3",
    "confidence": 0.94,
    "evidence": { "frame_ref": "s3://frames/cam3/1786807750.jpg" },
    "requested_outcome": "run the standard response for a stopped vehicle"
  }
}
```

We reply per message with one of:

| outcome | meaning |
|---|---|
| `accepted` | a new intent was opened, `intentId` included |
| `duplicate` | same `event_id`, or an identical payload inside the window |
| `debounced` | same `(detector, camera, class)` inside the window; attached to the open intent, with `occurrences` |
| `shed` | our queue is full. **We record every shed event in the ledger**, so this is visible, not silent |
| `rejected` | bad signature, stale timestamp, or schema violation, with a reason |

**You do not need to rate-limit yourself.** Send what you detect. We collapse repeats of the same class on the same camera into one intent rather than opening dozens. If you would rather we did not collapse, tell us the window you want.

---

## 6. What we do with a detection

1. **Screen the evidence.** Any text you send is treated as untrusted. Instruction-shaped content is redacted before it reaches a planner, and nothing you send is ever interpolated into a shell command or a filesystem path. Send whatever is genuinely useful; you cannot break us with a caption.
2. **Plan** the response using the runbook you gave us in section 2.
3. **Classify every step.** Reads run free. Writes that cannot cost money, create liability, or speak in our name run free and are logged with a way to undo them. Anything that can do those three things is **refused by policy** until a human decides.
4. **Execute**, and record every action in a hash-chained ledger with the authority it ran under.

---

## 7. Degraded mode

If our API is not up when you are ready to test, post the identical JSON body to the Telegram bot and we will bridge it by hand. **The contract is the payload, not the transport.** Build against the body shape and you are insulated from what we are doing on our side.

---

## 8. Getting your credentials

We issue you a token and a secret. They are printed once at boot and never logged.

- Do not commit them.
- Do not put them in a screenshot during the demo.
- Tell us if one leaks and we will rotate immediately; nothing you have built breaks when we do.

Ask in the channel and we will hand them over.
