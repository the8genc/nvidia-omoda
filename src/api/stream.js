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

/**
 * OUTBOUND client mode: dial a stream that is already pushing JSON (PRD 23.1).
 *
 * Two things keep this consistent with the inbound story rather than a second,
 * weaker door:
 *
 * 1. It runs in the HOST service only, next to the inbound listener. The
 *    original objection to outbound WebSockets was about SANDBOX egress, which
 *    cannot be L7-inspected; that objection stands and this does not touch it.
 * 2. Frames from a dialed stream are wrapped into the same signed envelope and
 *    fed through the SAME ingest: schema, dedupe, debounce, shed, and the
 *    propose-only identity all apply identically. We sign with our own dial
 *    identity because the signature attests "this process received this frame",
 *    not "the remote is trusted"; a dialed stream is still an untrusted input.
 *
 * A frame may be a bare payload or a full envelope. A remote-supplied event_id
 * is kept so retransmits dedupe; everything else about the remote is ignored.
 */
export function createUpstreamDialer({
  url, ingest, identity, WebSocketImpl,
  reconnectMs = 5000, maxReconnectMs = 60_000,
  now = () => Date.now(), onResult = null, onLog = () => {},
}) {
  if (!url) throw new Error("upstream dialer requires a url");
  if (!identity?.secret) throw new Error("upstream dialer requires a dial identity with a secret");
  let ws = null, running = false, backoff = reconnectMs, counter = 0, timer = null;

  function wrap(raw) {
    let frame;
    try { frame = JSON.parse(String(raw)); } catch { return null; }
    if (frame === null || typeof frame !== "object") return null;
    const payload = frame.payload && typeof frame.payload === "object" ? frame.payload : frame;
    const ts = Number.isInteger(frame.ts) ? frame.ts : Math.floor(now() / 1000);
    const eventId = typeof frame.event_id === "string" && frame.event_id
      ? frame.event_id
      : `dial-${createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16)}-${counter++}`;
    return JSON.stringify({ event_id: eventId, ts, sig: signEvent(identity.secret, eventId, ts, payload), payload });
  }

  function handleMessage(raw) {
    const wrapped = wrap(raw);
    const result = wrapped
      ? ingest.ingest(wrapped, identity)
      : { outcome: OUTCOME.REJECTED, reason: "frame is not a JSON object" };
    onResult?.(result);
    return result;
  }

  function connect() {
    ws = new WebSocketImpl(url);
    ws.on("open", () => { backoff = reconnectMs; onLog(`upstream connected: ${url}`); });
    ws.on("message", (d) => handleMessage(typeof d === "string" ? d : d.toString("utf8")));
    ws.on("error", () => { /* surfaced through close */ });
    ws.on("close", () => {
      if (!running) return;
      onLog(`upstream closed; redialing in ${Math.round(backoff / 1000)}s`);
      timer = setTimeout(() => { if (running) connect(); }, backoff);
      backoff = Math.min(backoff * 2, maxReconnectMs);
    });
  }

  return {
    handleMessage, // exposed so tests drive frames without a socket
    start() { running = true; connect(); },
    stop() { running = false; clearTimeout(timer); try { ws?.close(); } catch { /* gone */ } },
    get running() { return running; },
  };
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
