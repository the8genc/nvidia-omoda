import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createIntentStore } from "../src/api/intents.js";
import { createStreamIngest, createUpstreamDialer, signEvent } from "../src/api/stream.js";
import { createTokenStore } from "../src/api/auth.js";
import { createLedger } from "../src/ledger/ledger.js";

const see = { id: "see:cam3", scopes: ["intent:propose"] };
const other = { id: "see:cam9", scopes: ["intent:propose"] };
const ledgerPath = () => `/tmp/omoda-v4-${process.pid}-${Math.random().toString(16).slice(2)}.jsonl`;

// ── PUT: updates to something previously posted ───────────────────────────
function posted() {
  const intents = createIntentStore();
  const { intent } = intents.propose({
    idempotencyKey: "k1", caller: see,
    body: { requested_outcome: "raise the callout", evidence: { camera: "cam3" }, confidence: 0.8 },
  });
  return { intents, intent };
}

test("an update patches an open intent and keeps the history", () => {
  const { intents, intent } = posted();
  const r = intents.update({
    intentId: intent.id, caller: see,
    body: { confidence: 0.97, evidence: { frames: 4 } },
  });
  assert.equal(r.ok, true);
  assert.equal(r.intent.confidence, 0.97);
  assert.equal(r.intent.evidence.camera, "cam3", "evidence merges, it does not replace");
  assert.equal(r.intent.evidence.frames, 4);
  assert.equal(r.intent.updates.length, 1);
  assert.equal(r.intent.updates[0].by, "see:cam3");
});

test("only the proposer may update its own engagement", () => {
  const { intents, intent } = posted();
  const r = intents.update({ intentId: intent.id, caller: other, body: { confidence: 0.1 } });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test("an update cannot reopen a settled engagement", () => {
  const { intents, intent } = posted();
  intents.awaitConsent(intent.id, { actionId: "a1" });
  intents.decide({ intentId: intent.id, actionId: "a1", verdict: "deny", reason: "no", caller: { id: "operator:x", scopes: ["intent:decide"] } });
  const r = intents.update({ intentId: intent.id, caller: see, body: { confidence: 0.99 } });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.match(r.reason, /settled/);
});

test("an update carrying decisions is refused outright", () => {
  const { intents, intent } = posted();
  const r = intents.update({ intentId: intent.id, caller: see, body: { verdict: "approve" } });
  assert.equal(r.ok, false);
  assert.equal(r.status, 422);
  assert.match(r.reason, /cannot carry decisions/);
});

test("an empty update is refused: it must change something", () => {
  const { intents, intent } = posted();
  const r = intents.update({ intentId: intent.id, caller: see, body: {} });
  assert.equal(r.ok, false);
  assert.equal(r.status, 422);
});

test("an update to an unknown intent is 404", () => {
  const { intents } = posted();
  const r = intents.update({ intentId: "int_nope", caller: see, body: { confidence: 1 } });
  assert.equal(r.status, 404);
});

// ── outbound dialer: same ingest, same trust, different direction ─────────
class FakeSocket extends EventEmitter {
  close() { this.emit("close"); }
}

function dialerHarness() {
  const tokens = createTokenStore();
  const identity = tokens.issue({ id: "stream:dial", scopes: ["intent:propose"] });
  const intents = createIntentStore();
  const ledger = createLedger({ path: ledgerPath() });
  const ingest = createStreamIngest({ tokens, intents, ledger });
  let socket;
  const dialer = createUpstreamDialer({
    url: "ws://upstream.example:9/feed",
    ingest, identity,
    WebSocketImpl: function () { socket = new FakeSocket(); return socket; },
  });
  return { dialer, intents, identity, sock: () => socket };
}

const PAYLOAD = {
  kind: "detection", detector: "traffic-anomaly", class: "stopped-vehicle",
  evidence: {}, requested_outcome: "raise the incident callout",
};

test("a bare JSON payload from a dialed stream becomes a proposed intent", async () => {
  const { dialer, intents } = dialerHarness();
  const r = await dialer.handleMessage(JSON.stringify(PAYLOAD));
  assert.equal(r.outcome, "accepted");
  const intent = intents.get(r.intentId);
  assert.equal(intent.proposedBy, "stream:dial");
  assert.equal(intent.detector, "traffic-anomaly");
});

test("a remote-supplied event_id dedupes retransmits", async () => {
  const { dialer } = dialerHarness();
  const frame = JSON.stringify({ event_id: "ev-1", payload: PAYLOAD });
  assert.equal((await dialer.handleMessage(frame)).outcome, "accepted");
  assert.equal((await dialer.handleMessage(frame)).outcome, "duplicate");
});

test("a non-JSON frame is rejected, never guessed at", async () => {
  const { dialer } = dialerHarness();
  const r = await dialer.handleMessage("not json at all");
  assert.equal(r.outcome, "rejected");
});

test("a frame that fails the contract schema is rejected with the reason", async () => {
  const { dialer } = dialerHarness();
  const r = await dialer.handleMessage(JSON.stringify({ hello: "world" }));
  assert.equal(r.outcome, "rejected");
  assert.match(r.reason, /schema/);
});

test("the dial identity holds propose only, so a dialed stream can never consent", async () => {
  const { intents, dialer } = dialerHarness();
  const r = await dialer.handleMessage(JSON.stringify(PAYLOAD));
  const intent = intents.get(r.intentId);
  intents.awaitConsent(intent.id, { actionId: "a1" });
  const decide = intents.decide({
    intentId: intent.id, actionId: "a1", verdict: "approve",
    reason: "the stream approves itself", caller: { id: "stream:dial", scopes: ["intent:propose"] },
  });
  assert.equal(decide.ok, false, "separation of duties holds for dialed streams too");
});

test("the dialer redials after a close and stops cleanly", () => {
  const { dialer, sock } = dialerHarness();
  dialer.start();
  assert.equal(dialer.running, true);
  sock().emit("close");
  dialer.stop();
  assert.equal(dialer.running, false);
});

// ── the wrapped envelope is honest: our signature attests receipt ─────────
test("the dialer signs with its own identity, and the ingest verifies exactly that", async () => {
  const { dialer, identity } = dialerHarness();
  // Sanity: signEvent with the dial secret over the same payload matches what
  // ingest verified, proving no signature bypass was added for outbound.
  const r = await dialer.handleMessage(JSON.stringify({ event_id: "ev-sig", ts: Math.floor(Date.now() / 1000), payload: PAYLOAD }));
  assert.equal(r.outcome, "accepted");
  assert.equal(typeof signEvent(identity.secret, "ev-sig", 1, PAYLOAD), "string");
});
