import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createBus } from "../src/bus.js";
import {
  createAgenticTelemetry, setGlobalTelemetry, telemetry, bound, AGENTIC_EVENTS,
} from "../src/telemetry/agentic.js";
import { createInferenceClient } from "../src/models/client.js";
import { createStreamIngest, attachStreamServer } from "../src/api/stream.js";
import { createTokenStore } from "../src/api/auth.js";
import { createIntentStore } from "../src/api/intents.js";
import { createLedger } from "../src/ledger/ledger.js";
import { MODEL, ENDPOINT } from "../src/models/router.js";

test("the event catalog is the dashboard's contract", () => {
  assert.deepEqual([...AGENTIC_EVENTS], [
    "orchestration.route", "agent.message",
    "tool.call", "tool.result",
    "api.call", "api.result",
    "inference.call", "inference.result",
  ]);
});

test("bound() truncates, strips bearer tokens, auth headers, and base64 media", () => {
  const long = "x".repeat(1000);
  assert.match(bound(long), /…\[\+400 chars\]$/);
  assert.equal(bound({ authorization: "Bearer omoda_sekret_12345" }).includes("sekret"), false);
  assert.match(bound("Authorization: Bearer abc.def-ghi"), /Bearer \[stripped\]/);
  const withImage = `before data:image/jpeg;base64,${"A".repeat(200)} after`;
  assert.match(bound(withImage), /data:image\/\.\.\.;base64,\[stripped\]/);
  assert.equal(bound(withImage).includes("AAAA"), false);
});

test("emit envelopes carry event, correlationId, timestamp, and refuse unknown events", () => {
  const bus = createBus();
  const got = [];
  bus.subscribe("agentic", (e) => got.push(e));
  const t = createAgenticTelemetry({ bus });
  const e = t.route({ actor: "l0", target: "quickbooks.invoice.create", detail: { decision: "tool-selected" } });
  assert.equal(e.event, "orchestration.route");
  assert.ok(e.correlationId);
  assert.ok(e.at);
  assert.equal(got.length, 1);
  assert.equal(t.emit("made.up.event", {}), null);
  assert.equal(got.length, 1);
});

test("the global sink is a safe no-op until boot installs it", () => {
  setGlobalTelemetry(null);
  assert.equal(telemetry.route({ actor: "l0" }), null);
  assert.equal(telemetry.inferenceResult({}), null);
});

test("an instrumented inference call narrates a correlated call/result pair", async (t) => {
  const bus = createBus();
  const got = [];
  bus.subscribe("agentic", (e) => got.push(e));
  setGlobalTelemetry(createAgenticTelemetry({ bus }));
  t.after(() => setGlobalTelemetry(null));

  const client = createInferenceClient({
    fetchImpl: async () => ({
      ok: true, status: 200,
      async json() { return { model: MODEL.OMNI, choices: [{ message: { content: "the answer" }, finish_reason: "stop" }], usage: { total_tokens: 9 } }; },
    }),
  });
  await client.complete({ model: MODEL.OMNI, endpoint: ENDPOINT.LOCAL, messages: [{ role: "user", content: "secret question" }] });

  const call = got.find((e) => e.event === "inference.call");
  const result = got.find((e) => e.event === "inference.result");
  assert.ok(call && result, "both halves narrated");
  assert.equal(call.correlationId, result.correlationId, "the dashboard can pair them");
  assert.equal(result.detail.usage.total_tokens, 9);
  assert.match(result.detail.output, /the answer/);
});

test("the /v1/out/agentic endpoint delivers to a read-scoped viewer over a real socket", async (t) => {
  const { WebSocket } = await import("ws");
  const bus = createBus();
  const tokens = createTokenStore();
  const viewer = tokens.issue({ id: "demo:viewer", scopes: ["intent:read"] });
  const ingest = createStreamIngest({
    tokens, intents: createIntentStore(),
    ledger: createLedger({ path: `/tmp/omoda-agentic-${Date.now()}.jsonl` }),
  });
  const server = createServer((_q, r) => { r.writeHead(426); r.end(); });
  await attachStreamServer({ server, ingest, outputs: { bus, tokens } });
  await new Promise((r) => server.listen(3162, "127.0.0.1", r));
  t.after(() => server.close());

  const refused = await new Promise((resolve) => {
    const ws = new WebSocket("ws://127.0.0.1:3162/v1/out/agentic");
    ws.on("unexpected-response", (_r, res) => resolve(res.statusCode));
  });
  assert.equal(refused, 401);

  const got = [];
  const ws = await new Promise((resolve, reject) => {
    const w = new WebSocket("ws://127.0.0.1:3162/v1/out/agentic", { headers: { authorization: `Bearer ${viewer.token}` } });
    w.on("open", () => resolve(w));
    w.on("message", (d) => got.push(JSON.parse(String(d))));
    w.on("unexpected-response", (_r, res) => reject(new Error(`refused ${res.statusCode}`)));
  });
  t.after(() => ws.close());

  const tel = createAgenticTelemetry({ bus });
  tel.apiCall({ actor: "l3:openclaw", target: "agents.list", detail: { url: "ws://gw" } });
  tel.message({ actor: "judge", target: "l0", detail: { handoff: "incident-intent" } });

  await new Promise((resolve) => { const i = setInterval(() => { if (got.length >= 2) { clearInterval(i); resolve(); } }, 15); });
  assert.equal(got[0].topic, "agentic");
  assert.equal(got[0].event, "api.call");
  assert.equal(got[1].event, "agent.message");
  assert.equal(got[1].detail.handoff, "incident-intent");
});
