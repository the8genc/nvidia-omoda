import { test } from "node:test";
import assert from "node:assert/strict";
import { createStreamIngest, signEvent } from "../src/api/stream.js";
import { createTokenStore } from "../src/api/auth.js";
import { createIntentStore } from "../src/api/intents.js";
import { createLedger } from "../src/ledger/ledger.js";

function harness(opts = {}) {
  const tokens = createTokenStore();
  const see = tokens.issue({ id: "see:cam3", scopes: ["intent:propose"] });
  const op = tokens.issue({ id: "operator:arif", scopes: ["intent:propose", "intent:decide"] });
  const ledger = createLedger({ path: `/tmp/omoda-stream-${Date.now()}-${Math.random()}.jsonl` });
  const ingest = createStreamIngest({ tokens, intents: createIntentStore(), ledger, ...opts });
  return { ingest, see, op, ledger };
}

const payload = (over = {}) => ({
  kind: "detection", detector: "traffic-anomaly", class: "stopped-vehicle",
  camera: "cam3", confidence: 0.91, evidence: { frame_ref: "f/1" },
  requested_outcome: "run the standard response", ...over,
});

function ev(secret, id, p = payload(), tsOffsetSec = 0) {
  const ts = Math.floor(Date.now() / 1000) + tsOffsetSec;
  return JSON.stringify({ event_id: id, ts, sig: signEvent(secret, id, ts, p), payload: p });
}

test("accept requires intent:propose", () => {
  const { ingest, see } = harness();
  assert.equal(ingest.accept({ headers: { authorization: `Bearer ${see.token}` } }).ok, true);
  assert.equal(ingest.accept({ headers: {} }).ok, false);
});

test("KEYSTONE: a decide-capable token may not drive a stream", () => {
  const { ingest, op } = harness();
  const r = ingest.accept({ headers: { authorization: `Bearer ${op.token}` } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /decide-capable/);
});

test("a well-formed signed event is accepted and creates one intent", () => {
  const { ingest, see } = harness();
  const r = ingest.ingest(ev(see.secret, "e1"), see);
  assert.equal(r.outcome, "accepted");
  assert.match(r.intentId, /^int_/);
});

test("a forged signature is rejected", () => {
  const { ingest, see } = harness();
  const bad = JSON.parse(ev(see.secret, "e2"));
  bad.sig = "sha256=deadbeef";
  assert.equal(ingest.ingest(JSON.stringify(bad), see).outcome, "rejected");
});

test("a replayed event_id is a duplicate, not a second intent", () => {
  const { ingest, see } = harness();
  const raw = ev(see.secret, "e3");
  assert.equal(ingest.ingest(raw, see).outcome, "accepted");
  assert.equal(ingest.ingest(raw, see).outcome, "duplicate");
});

test("an identical payload under a new id is still a duplicate", () => {
  const { ingest, see } = harness();
  const p = payload();
  assert.equal(ingest.ingest(ev(see.secret, "a1", p), see).outcome, "accepted");
  assert.equal(ingest.ingest(ev(see.secret, "a2", p), see).outcome, "duplicate");
});

test("repeats of the same detector/camera/class debounce into one intent", () => {
  const { ingest, see } = harness({ debounceMs: 60_000 });
  const first = ingest.ingest(ev(see.secret, "d1", payload({ evidence: { frame_ref: "f/1" } })), see);
  assert.equal(first.outcome, "accepted");
  const second = ingest.ingest(ev(see.secret, "d2", payload({ evidence: { frame_ref: "f/2" } })), see);
  assert.equal(second.outcome, "debounced");
  assert.equal(second.intentId, first.intentId, "the repeat attaches to the open intent");
  assert.equal(second.occurrences, 2);
});

test("a different class is NOT debounced away", () => {
  const { ingest, see } = harness({ debounceMs: 60_000 });
  ingest.ingest(ev(see.secret, "c1", payload({ class: "stopped-vehicle" })), see);
  const other = ingest.ingest(ev(see.secret, "c2", payload({ class: "pedestrian-in-lane" })), see);
  assert.equal(other.outcome, "accepted", "a distinct event class deserves its own intent");
});

test("the queue sheds when full, and the drop is LEDGERED", () => {
  const { ingest, see, ledger } = harness({ maxInFlight: 2, debounceMs: 0 });
  ingest.ingest(ev(see.secret, "s1", payload({ class: "a" })), see);
  ingest.ingest(ev(see.secret, "s2", payload({ class: "b" })), see);
  const shed = ingest.ingest(ev(see.secret, "s3", payload({ class: "c" })), see);
  assert.equal(shed.outcome, "shed");
  const drops = ledger.all().filter((r) => r.outcome === "shed");
  assert.equal(drops.length, 1, "a silently dropped detection is worse than a logged one");
  assert.equal(drops[0].eventId, "s3");
});

test("release frees capacity so a shed is temporary, not terminal", () => {
  const { ingest, see } = harness({ maxInFlight: 1, debounceMs: 0 });
  ingest.ingest(ev(see.secret, "r1", payload({ class: "a" })), see);
  assert.equal(ingest.ingest(ev(see.secret, "r2", payload({ class: "b" })), see).outcome, "shed");
  ingest.release();
  assert.equal(ingest.ingest(ev(see.secret, "r3", payload({ class: "c" })), see).outcome, "accepted");
});

test("a stale timestamp is rejected", () => {
  const { ingest, see } = harness();
  assert.equal(ingest.ingest(ev(see.secret, "t1", payload(), -600), see).outcome, "rejected");
});

test("unknown envelope fields are rejected", () => {
  const { ingest, see } = harness();
  const p = payload();
  const ts = Math.floor(Date.now() / 1000);
  const raw = JSON.stringify({ event_id: "x1", ts, sig: signEvent(see.secret, "x1", ts, p), payload: p, exec: "rm -rf /" });
  assert.equal(ingest.ingest(raw, see).outcome, "rejected");
});
