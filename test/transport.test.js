import { test } from "node:test";
import assert from "node:assert/strict";
import { createEnvelope, SOURCE, DIRECTION, MODALITY } from "../src/transport/envelope.js";
import { createIntentStore } from "../src/api/intents.js";
import { createStreamIngest, createUpstreamDialer, signEvent } from "../src/api/stream.js";
import { createTokenStore } from "../src/api/auth.js";
import { createLedger } from "../src/ledger/ledger.js";
import { createTelegramClient } from "../src/channels/telegram.js";
import { createTelegramLoop } from "../src/channels/telegram-loop.js";
import { MODEL, ENDPOINT } from "../src/models/router.js";

const ledger = () => createLedger({ path: `/tmp/omoda-transport-${Date.now()}-${Math.random()}.jsonl` });

test("the envelope refuses unknown sources, directions and modalities", () => {
  assert.throws(() => createEnvelope({ source: "carrier-pigeon", direction: DIRECTION.INBOUND, modality: MODALITY.JSON }), /unknown source/);
  assert.throws(() => createEnvelope({ source: SOURCE.API, direction: "sideways", modality: MODALITY.JSON }), /unknown direction/);
  assert.throws(() => createEnvelope({ source: SOURCE.API, direction: DIRECTION.INBOUND, modality: "smoke-signal" }), /unknown modality/);
});

test("the envelope is frozen: which door it was cannot be rewritten later", () => {
  const e = createEnvelope({ source: SOURCE.API, direction: DIRECTION.INBOUND, modality: MODALITY.JSON });
  assert.throws(() => { "use strict"; e.source = "telegram"; }, TypeError);
});

// The requirement in one test: every door produces the IDENTICAL shape, and
// nothing downstream can tell which door an engagement came through except by
// reading the envelope that says so.
test("all doors produce the same canonical envelope shape", async () => {
  const tokens = createTokenStore();
  const intents = createIntentStore();
  const led = ledger();
  const envelopes = [];

  // Door 1: WebSocket, inbound (a producer connected to us).
  {
    const see = tokens.issue({ id: "see:cam3", scopes: ["intent:propose"] });
    const ingest = createStreamIngest({ tokens, intents, ledger: led });
    const payload = { kind: "detection", detector: "d", evidence: {}, requested_outcome: "x" };
    const ts = Math.floor(Date.now() / 1000);
    const raw = JSON.stringify({ event_id: "ev-in", ts, sig: signEvent(see.secret, "ev-in", ts, payload), payload });
    const r = ingest.ingest(raw, see);
    envelopes.push(intents.get(r.intentId).envelope);
  }

  // Door 1b: WebSocket, outbound dial (we connected to a pushing stream).
  {
    const dial = tokens.issue({ id: "stream:dial", scopes: ["intent:propose"] });
    const ingest = createStreamIngest({ tokens, intents, ledger: led });
    const dialer = createUpstreamDialer({
      url: "ws://x", ingest, identity: dial, WebSocketImpl: function () { return { on() {} }; },
    });
    const r = dialer.handleMessage(JSON.stringify({ kind: "detection", detector: "d2", evidence: {}, requested_outcome: "y" }));
    envelopes.push(intents.get(r.intentId).envelope);
  }

  // Door 2: the API (POST body, via the store the route calls).
  {
    const { intent } = intents.propose({
      idempotencyKey: "api-1", caller: { id: "svc:x", scopes: ["intent:propose"] },
      envelope: createEnvelope({ source: SOURCE.API, direction: DIRECTION.INBOUND, modality: MODALITY.JSON, idempotencyKey: "api-1" }),
      body: { requested_outcome: "z" },
    });
    envelopes.push(intent.envelope);
  }

  // Door 3: Telegram voice, through the live loop with a fake transform.
  {
    const transport = async (m) => (m === "getUpdates" ? { ok: true, result: [] } : { ok: true, result: {} });
    const client = createTelegramClient({ transport, allowedIds: [111] });
    const loop = createTelegramLoop({
      client, intents, ledger: led, operator: { id: "op", scopes: [] }, transport,
      mediaTransform: { async transform() { return { modality: "voice", transcript: "do the thing", flags: [], screened: false, model: MODEL.OMNI, endpoint: ENDPOINT.LOCAL, egress: "local", bytes: 1, latencyMs: 1 }; } },
    });
    const r = await loop.handle({ update_id: 1, message: { voice: { file_id: "fv" }, from: { id: 111 }, chat: { id: 5 } } });
    envelopes.push(intents.get(r.intentId).envelope);
  }

  // Same keys, every door.
  const KEYS = ["source", "direction", "modality", "idempotency_key", "received_at"].sort();
  for (const e of envelopes) {
    assert.ok(e, "every engagement carries an envelope");
    assert.deepEqual(Object.keys(e).sort(), KEYS);
    assert.match(e.received_at, /^\d{4}-\d{2}-\d{2}T/);
  }

  // And each says truthfully which door and direction it was.
  assert.deepEqual(
    envelopes.map((e) => [e.source, e.direction, e.modality]),
    [
      ["stream", "inbound", "json"],
      ["stream", "outbound-dial", "json"],
      ["api", "inbound", "json"],
      ["telegram", "inbound", "voice"],
    ],
  );
});
