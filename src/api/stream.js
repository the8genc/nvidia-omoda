// WebSocket stream ingress. INBOUND: we serve, producers connect.
//
// This direction is a containment decision, not a preference. An OUTBOUND
// WebSocket needs an OpenShell egress entry, and a WebSocket cannot be
// inspected as HTTP, so that entry must be a raw L4 tunnel (access: full,
// tls: skip) with no method or path filtering. That is exactly the control the
// whole architecture rests on. Serving inbound widens the envelope by nothing.
//
// A stream is still an untrusted input source: the socket authenticates once at
// accept with intent:propose and nothing else, so a feed can open work but can
// never consent to it.

import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { SCOPES, SIGNATURE_WINDOW_MS } from "./auth.js";

export const StreamEnvelope = z.object({
  event_id: z.string().min(1).max(200),
  ts: z.number().int(),
  sig: z.string().min(1),
  payload: z.object({
    kind: z.literal("detection").default("detection"),
    detector: z.string().min(1),
    class: z.string().min(1).optional(),
    camera: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
    evidence: z.record(z.unknown()).default({}),
    requested_outcome: z.string().min(1),
  }).strict(),
}).strict();

export function signEvent(secret, eventId, ts, payload) {
  return "sha256=" + createHmac("sha256", secret)
    .update(`${eventId}.${ts}.${JSON.stringify(payload)}`).digest("hex");
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const OUTCOME = Object.freeze({
  ACCEPTED: "accepted",
  DUPLICATE: "duplicate",
  DEBOUNCED: "debounced",
  SHED: "shed",
  REJECTED: "rejected",
});

/**
 * @param {object} opts
 * @param {number} opts.debounceMs   collapse repeats of the same (detector,camera,class)
 * @param {number} opts.maxInFlight  bounded queue; beyond this we shed and SAY SO
 */
export function createStreamIngest({
  tokens, intents, ledger,
  debounceMs = 30_000,
  dedupeMax = 5000,
  maxInFlight = 25,
} = {}) {
  const seenEvents = new Map();   // event_id  -> expiry
  const seenContent = new Map();  // hash      -> expiry
  const lastByKey = new Map();    // debounce key -> { at, intentId, occurrences }
  let inFlight = 0;

  const sweep = (map, now) => { for (const [k, exp] of map) { if (exp <= now) map.delete(k); else break; } };

  /** Accept-time authorization. Propose scope only, by design. */
  function accept({ headers = {} } = {}) {
    const auth = headers["authorization"] ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
    const caller = bearer ? tokens.get(bearer) : null;
    if (!caller) return { ok: false, code: 4401, reason: "unknown token" };
    if (!caller.scopes.includes(SCOPES.PROPOSE)) {
      return { ok: false, code: 4403, reason: `stream requires ${SCOPES.PROPOSE}` };
    }
    if (caller.scopes.includes(SCOPES.DECIDE)) {
      // Defence in depth. A decide-capable identity has no business on a feed,
      // and allowing it here would make the keystone depend on configuration.
      return { ok: false, code: 4403, reason: "a decide-capable token may not drive a stream" };
    }
    return { ok: true, caller };
  }

  function release() { if (inFlight > 0) inFlight -= 1; }

  function ingest(raw, caller, now = Date.now()) {
    let env;
    try { env = StreamEnvelope.parse(typeof raw === "string" ? JSON.parse(raw) : raw); }
    catch (err) { return { outcome: OUTCOME.REJECTED, reason: `schema: ${String(err.message).slice(0, 160)}` }; }

    if (Math.abs(now - env.ts * 1000) > SIGNATURE_WINDOW_MS) {
      return { outcome: OUTCOME.REJECTED, reason: "timestamp outside the accepted window" };
    }
    if (!safeEqual(env.sig, signEvent(caller.secret, env.event_id, env.ts, env.payload))) {
      return { outcome: OUTCOME.REJECTED, reason: "signature mismatch" };
    }

    sweep(seenEvents, now);
    sweep(seenContent, now);

    if (seenEvents.has(env.event_id)) {
      return { outcome: OUTCOME.DUPLICATE, reason: "event_id already seen" };
    }
    const contentHash = createHash("sha256").update(JSON.stringify(env.payload)).digest("hex").slice(0, 24);
    if (seenContent.has(contentHash)) {
      return { outcome: OUTCOME.DUPLICATE, reason: "identical payload inside the window" };
    }

    const p = env.payload;
    const key = `${p.detector}|${p.camera ?? "-"}|${p.class ?? "-"}`;
    const prior = lastByKey.get(key);
    if (prior && now - prior.at < debounceMs) {
      prior.occurrences += 1;
      seenEvents.set(env.event_id, now + SIGNATURE_WINDOW_MS);
      return { outcome: OUTCOME.DEBOUNCED, intentId: prior.intentId, occurrences: prior.occurrences };
    }

    // Bounded queue. A shed event is RECORDED: a silently dropped detection is
    // worse than a logged one, because nobody can tell the difference between
    // "nothing happened" and "we dropped it".
    if (inFlight >= maxInFlight) {
      try {
        ledger?.append({
          kind: "stream", agent: caller.id, tool: "stream.ingest", verb: "read",
          outcome: "shed", reason: "queue full", eventId: env.event_id, detector: p.detector,
        });
      } catch { /* the shed record is best effort; the shed itself still stands */ }
      return { outcome: OUTCOME.SHED, reason: "in-flight cap reached" };
    }

    seenEvents.set(env.event_id, now + SIGNATURE_WINDOW_MS);
    seenContent.set(contentHash, now + debounceMs);
    if (seenEvents.size > dedupeMax) seenEvents.delete(seenEvents.keys().next().value);

    const { intent } = intents.propose({
      idempotencyKey: env.event_id,
      body: {
        source: "stream", kind: "detection", detector: p.detector,
        confidence: p.confidence, observed_at: new Date(env.ts * 1000).toISOString(),
        evidence: { ...p.evidence, camera: p.camera, class: p.class },
        requested_outcome: p.requested_outcome,
      },
      caller,
    });

    inFlight += 1;
    lastByKey.set(key, { at: now, intentId: intent.id, occurrences: 1 });
    return { outcome: OUTCOME.ACCEPTED, intentId: intent.id };
  }

  return { accept, ingest, release, get inFlight() { return inFlight; }, OUTCOME };
}

/** Wire the ingest to a real WebSocket server on an existing http server. */
export async function attachStreamServer({ server, ingest, path = "/v1/stream" }) {
  const { WebSocketServer } = await import("ws");
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== path) { socket.destroy(); return; }
    const auth = ingest.accept({ headers: req.headers });
    if (!auth.ok) {
      socket.write(`HTTP/1.1 401 Unauthorized\r\n\r\n${auth.reason}`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (data) => {
        const result = ingest.ingest(String(data), auth.caller);
        ws.send(JSON.stringify(result));
      });
    });
  });

  return wss;
}
