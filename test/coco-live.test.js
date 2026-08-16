import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createBus, TOPICS } from "../src/bus.js";
import { createCocoLive, toObservation } from "../src/coco/live.js";
import { createObservationJudge, candidateSignals } from "../src/coco/judge.js";
import { createIntentStore } from "../src/api/intents.js";
import { createLedger } from "../src/ledger/ledger.js";
import { createStreamIngest, attachStreamServer } from "../src/api/stream.js";
import { createTokenStore } from "../src/api/auth.js";
import { bridgeSocket } from "../src/api/outputs.js";
import { narrateEntry } from "../src/telemetry/narrate.js";
import { MODEL, ENDPOINT } from "../src/models/router.js";

const ledger = (onAppend) => createLedger({ path: `/tmp/omoda-live-${Date.now()}-${Math.random()}.jsonl`, onAppend });
const TINY_JPEG = "data:image/jpeg;base64," + Buffer.from("fake-jpeg-bytes").toString("base64");

const NOMINAL_MSG = { prompt: null, description: "Vehicles move through the intersection. Pedestrians wait at the corners." };
const DANGER_MSG = {
  prompt: null,
  description: "A red car is smoking at an intersection, with two firefighters attending to it. A fire truck is present.",
  followup: { question: "Is there an imminent danger to the public?", answer: true },
};

const fakeInference = (reply) => ({
  calls: [],
  async complete(args) { this.calls.push(args); return { text: JSON.stringify(reply), model: MODEL.OMNI, endpoint: args.endpoint ?? ENDPOINT.LOCAL }; },
});
const INCIDENT = { is_incident: true, incident_type: "traffic-accident", severity: "high", reason: "vehicle fire attended by firefighters", cleared: false };

function harness({ reply = INCIDENT } = {}) {
  const bus = createBus();
  const intents = createIntentStore();
  const inference = fakeInference(reply);
  const led = ledger((rec) => bus.publish("agent", narrateEntry(rec)));
  const judge = createObservationJudge({ intents, ledger: led, inference });
  const live = createCocoLive({
    base: "http://coco.test:8091", judge, bus, ledger: led,
    WebSocketImpl: function () { return { on() {} }; },
    fetchImpl: async () => ({ ok: true, status: 200, async json() { return { description: "clear view of the intersection" }; } }),
  });
  return { bus, intents, inference, led, live, judge };
}

// ── the bus ────────────────────────────────────────────────────────────────
test("the bus publishes to subscribers and isolates a throwing one", () => {
  const bus = createBus();
  const got = [];
  bus.subscribe("frame", () => { throw new Error("bad subscriber"); });
  bus.subscribe("frame", (e) => got.push(e));
  bus.publish("frame", { seq: 1 });
  assert.equal(got.length, 1);
  assert.equal(got[0].topic, "frame");
  assert.throws(() => bus.publish("nope", {}), /unknown bus topic/);
  assert.deepEqual(TOPICS, ["frame", "observation", "agent", "agentic", "audit"]);
});

// ── the live shapes ────────────────────────────────────────────────────────
test("a live frame is relayed with zero re-encode: envelope spliced, payload untouched, never judged", async () => {
  const { bus, live, inference } = harness();
  const frames = [];
  bus.subscribe("frame", (e) => frames.push(e));
  const r = live.handleFrame(JSON.stringify({ seq: 287303, index: 14747, rgb: TINY_JPEG }));
  assert.equal(r.kind, "frame");
  assert.equal(frames[0].seq, 287303);
  // What a subscriber receives parses to the contract shape, and the rgb bytes
  // are byte-identical to COCO's without ever being decoded in the hub.
  const wire = JSON.parse(frames[0].precomposed);
  assert.equal(wire.topic, "frame");
  assert.equal(wire.seq, 287303);
  assert.equal(wire.rgb, TINY_JPEG);
  assert.ok(frames[0].precomposed.includes(TINY_JPEG), "payload spliced, not re-escaped");
  assert.equal(inference.calls.length, 0);
});

test("a slow frame subscriber is capped at about two frames of standing queue, not two megabytes", async () => {
  const { bridgeSocket } = await import("../src/api/outputs.js");
  const bus2 = createBus();
  const sends = [];
  const viewer = { readyState: 1, bufferedAmount: 0, send: (d) => sends.push(d), on() {} };
  bridgeSocket({ ws: viewer, bus: bus2, topic: "frame" });
  viewer.bufferedAmount = 200 * 1024; // ~2.5 frames already queued
  bus2.publish("frame", { seq: 1, precomposed: "{}" });
  assert.equal(sends.length, 0, "beyond ~2 frames the clock is protected, drops take the slack");
  viewer.bufferedAmount = 100 * 1024; // just over one frame queued: still sends
  bus2.publish("frame", { seq: 2, precomposed: "{}" });
  assert.equal(sends.length, 1);
});

test("the followup danger boolean and the hazard lexicon both make candidates", () => {
  const dangerObs = toObservation(DANGER_MSG, { seq: 1, source: "test" });
  const signals = candidateSignals(dangerObs);
  assert.ok(signals.includes("followup:danger_true"));
  assert.ok(signals.includes("description:danger_lexicon"));
  assert.deepEqual(candidateSignals(toObservation(NOMINAL_MSG, { seq: 2, source: "test" })), []);
});

test("a nominal live description costs zero inference and publishes verdict nominal", async () => {
  const { bus, live, inference, intents } = harness();
  const out = [];
  bus.subscribe("observation", (e) => out.push(e));
  const r = await live.handleObservability(JSON.stringify(NOMINAL_MSG));
  assert.equal(r.verdict, "nominal");
  assert.equal(inference.calls.length, 0);
  assert.equal(intents.all().length, 0);
  assert.equal(out[0].description, NOMINAL_MSG.description);
});

test("the smoking-car description becomes a judged incident with an intent, published with the verdict", async () => {
  const { bus, live, intents } = harness();
  const out = [];
  bus.subscribe("observation", (e) => out.push(e));
  await live.handleObservability(JSON.stringify(NOMINAL_MSG));
  const r = await live.handleObservability(JSON.stringify(DANGER_MSG));

  assert.equal(r.verdict, "incident");
  const intent = intents.get(r.intentId);
  assert.equal(intent.proposedBy, "coco:coco-live");
  assert.match(intent.evidence.evidence_ref.source, /api\/observability/);
  assert.equal(out[1].verdict, "incident");
  assert.equal(out[1].danger_signal, true);
});

test("describe() asks the one-off question and is ledgered either way", async () => {
  const { live, led } = harness();
  const a = await live.describe("Is the lane blocked?");
  assert.equal(a.description, "clear view of the intersection");
  assert.ok(led.all().some((e) => e.tool === "coco.describe" && e.outcome === "answered"));
});

test("agent activity reaches the bus as a thin ticker event: agent name and action only", async () => {
  const { bus, led } = harness();
  const agentEvents = [];
  bus.subscribe("agent", (e) => agentEvents.push(e));
  led.append({ kind: "api", agent: "operator:arif", tool: "intents.update", verb: "update", outcome: "updated", reason: "operator edited the engagement" });
  assert.equal(agentEvents.length, 1);
  const e = agentEvents[0];
  assert.equal(e.agent, "the operator", "just the agent name");
  assert.equal(e.action, "operator edited the engagement", "and the action it is taking");
  assert.equal(e.seq, 1, "seq links back to the full record on /v1/ledger and /ui/audit");
  assert.equal(e.headline, undefined, "no prose headline; the detail is in the audit trail");
  assert.equal(e.entry, undefined, "the bulky record is not on the wire");
});

// ── the output layer over a REAL socket ───────────────────────────────────
test("the demo app subscribes with no token and sees frames, observations, and agent activity live", async (t) => {
  const { WebSocket } = await import("ws");
  const bus = createBus();
  const tokens = createTokenStore();
  const viewer = tokens.issue({ id: "demo:viewer", scopes: ["intent:read"] });
  const proposeOnly = tokens.issue({ id: "see:cam", scopes: ["intent:propose"] });
  const ingest = createStreamIngest({ tokens, intents: createIntentStore(), ledger: ledger() });

  const server = createServer((_q, r) => { r.writeHead(426); r.end(); });
  await attachStreamServer({ server, ingest, outputs: { bus, tokens, open: true } });
  await new Promise((r) => server.listen(3161, "127.0.0.1", r));
  t.after(() => server.close());

  // Outputs are OPEN by decision (same-hardware consumers); ingest is not.
  // Watching is free, proposing still needs a token.
  const ingestRefused = await new Promise((resolve) => {
    const ws = new WebSocket("ws://127.0.0.1:3161/v1/stream");
    ws.on("unexpected-response", (_r, res) => resolve(res.statusCode));
    ws.on("open", () => resolve("OPENED"));
  });
  assert.equal(ingestRefused, 401, "the ingest door keeps its token");
  void viewer; void proposeOnly;

  const received = { frame: [], observation: [], agent: [] };
  const open = (path, key) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:3161${path}`);
    ws.on("open", () => resolve(ws));
    ws.on("message", (d) => received[key].push(JSON.parse(String(d))));
    ws.on("unexpected-response", (_r, res) => reject(new Error(`refused ${res.statusCode}`)));
  });
  const sockets = await Promise.all([
    open("/v1/out/frames", "frame"), open("/v1/out/observations", "observation"), open("/v1/out/agents", "agent"),
  ]);
  t.after(() => sockets.forEach((w) => w.close()));

  bus.publish("frame", { seq: 1, rgb: TINY_JPEG });
  bus.publish("observation", { description: "nominal", verdict: "nominal" });
  bus.publish("agent", narrateEntry({ seq: 7, agent: "omoda:judge", tool: "judge.incident", outcome: "intent-opened", reason: "traffic-accident high" }));

  await new Promise((resolve) => { const i = setInterval(() => { if (received.frame.length && received.observation.length && received.agent.length) { clearInterval(i); resolve(); } }, 15); });
  assert.equal(received.frame[0].seq, 1);
  assert.equal(received.observation[0].verdict, "nominal");
  assert.equal(received.agent[0].agent, "omoda judge", "just the agent name arrives");
  assert.equal(received.agent[0].action, "traffic-accident high", "and the action it is taking");
});

test("a lagging viewer gets frames dropped, never an unbounded queue", () => {
  const bus = createBus();
  const sends = [];
  const laggy = {
    readyState: 1, bufferedAmount: 99 * 1024 * 1024,
    send: (d) => sends.push(d), on() {},
  };
  const bridge = bridgeSocket({ ws: laggy, bus, topic: "frame" });
  bus.publish("frame", { seq: 1 });
  bus.publish("frame", { seq: 2 });
  assert.equal(sends.length, 0);
  assert.equal(bridge.stats().dropped, 2);
  laggy.bufferedAmount = 0;
  bus.publish("frame", { seq: 3 });
  assert.equal(sends.length, 1, "recovers as soon as the buffer drains");
});
