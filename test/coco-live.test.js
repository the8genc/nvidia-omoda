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
  const led = ledger((rec) => bus.publish("agent", { entry: rec }));
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
  assert.deepEqual(TOPICS, ["frame", "observation", "agent", "agentic"]);
});

// ── the live shapes ────────────────────────────────────────────────────────
test("a live frame is relayed on the bus verbatim, never judged", async () => {
  const { bus, live, inference } = harness();
  const frames = [];
  bus.subscribe("frame", (e) => frames.push(e));
  const r = live.handleFrame(JSON.stringify({ seq: 287303, index: 14747, rgb: TINY_JPEG }));
  assert.equal(r.kind, "frame");
  assert.equal(frames[0].seq, 287303);
  assert.equal(frames[0].rgb, TINY_JPEG);
  assert.equal(inference.calls.length, 0);
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

test("agent activity flows to the bus through the ledger hook", async () => {
  const { bus, led } = harness();
  const agentEvents = [];
  bus.subscribe("agent", (e) => agentEvents.push(e));
  led.append({ kind: "api", agent: "operator:arif", tool: "intents.update", verb: "update", outcome: "updated" });
  assert.equal(agentEvents.length, 1);
  assert.equal(agentEvents[0].entry.tool, "intents.update");
  assert.ok(agentEvents[0].entry.hash, "the demo app sees the same hash-chained record the audit does");
});

// ── the output layer over a REAL socket ───────────────────────────────────
test("the demo app subscribes with a read token and sees frames, observations, and agent activity live", async (t) => {
  const { WebSocket } = await import("ws");
  const bus = createBus();
  const tokens = createTokenStore();
  const viewer = tokens.issue({ id: "demo:viewer", scopes: ["intent:read"] });
  const proposeOnly = tokens.issue({ id: "see:cam", scopes: ["intent:propose"] });
  const ingest = createStreamIngest({ tokens, intents: createIntentStore(), ledger: ledger() });

  const server = createServer((_q, r) => { r.writeHead(426); r.end(); });
  await attachStreamServer({ server, ingest, outputs: { bus, tokens } });
  await new Promise((r) => server.listen(3161, "127.0.0.1", r));
  t.after(() => server.close());

  // No token: refused. Propose-only token: refused (read is the viewer scope).
  for (const hdrs of [{}, { authorization: `Bearer ${proposeOnly.token}` }]) {
    const refused = await new Promise((resolve) => {
      const ws = new WebSocket("ws://127.0.0.1:3161/v1/out/agents", { headers: hdrs });
      ws.on("unexpected-response", (_r, res) => resolve(res.statusCode));
      ws.on("open", () => resolve("OPENED"));
    });
    assert.equal(refused, 401);
  }

  const received = { frame: [], observation: [], agent: [] };
  const open = (path, key) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:3161${path}`, { headers: { authorization: `Bearer ${viewer.token}` } });
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
  bus.publish("agent", { entry: { tool: "judge.incident", outcome: "intent-opened" } });

  await new Promise((resolve) => { const i = setInterval(() => { if (received.frame.length && received.observation.length && received.agent.length) { clearInterval(i); resolve(); } }, 15); });
  assert.equal(received.frame[0].seq, 1);
  assert.equal(received.observation[0].verdict, "nominal");
  assert.equal(received.agent[0].entry.tool, "judge.incident");
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
