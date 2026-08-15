import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { createApp } from "../src/api/server.js";
import { createTokenStore } from "../src/api/auth.js";
import { createLedger } from "../src/ledger/ledger.js";
import { createIntentStore } from "../src/api/intents.js";
import { compile } from "../src/policy/compile.js";

const manifest = parse(
  readFileSync(new URL("./fixtures/invoice-dispatch.yaml", import.meta.url), "utf8"),
);

function harness() {
  const tokens = createTokenStore();
  const see = tokens.issue({ id: "see:cam3", scopes: ["intent:propose"] });
  const op = tokens.issue({ id: "operator:arif", scopes: ["intent:read", "intent:decide", "ledger:read"] });
  const intents = createIntentStore();
  const ledger = createLedger({ path: `/tmp/omoda-ui-${Date.now()}-${Math.random()}.jsonl` });
  const { registry } = compile(manifest);
  const app = createApp({
    tokens, ledger, intents, uiOperator: op,
    skills: [{ skill: manifest.skill, agent: manifest.agent, registry }],
  });
  return { app, intents, ledger, see, op };
}

async function get(app, path) {
  let status, body = "";
  const res = { writeHead(s) { status = s; }, end(b) { body = String(b ?? ""); } };
  await app.handle({ method: "GET", url: path, headers: {}, async *[Symbol.asyncIterator]() {} }, res);
  return { status, body };
}

async function post(app, path, form) {
  const raw = new URLSearchParams(form).toString();
  let status, body = "", headers;
  const res = { writeHead(s, hh) { status = s; headers = hh; }, end(b) { body = String(b ?? ""); } };
  const chunks = [Buffer.from(raw)];
  await app.handle(
    { method: "POST", url: path, headers: {}, async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; } },
    res,
  );
  return { status, body, headers };
}

const csrfFrom = (html) => html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];

test("the skills page renders the compiled capability registry", async () => {
  const { app } = harness();
  const r = await get(app, "/ui");
  assert.equal(r.status, 200);
  assert.match(r.body, /^<!doctype html>/);
  assert.match(r.body, /quickbooks\.invoice\.create/);
  assert.match(r.body, /two-person/, "the delete carrying financial and legal shows its stage");
  assert.match(r.body, /autonomous/, "a read is shown as needing no consent");
});

test("the UI ships no client javascript", async () => {
  const { app } = harness();
  const r = await get(app, "/ui");
  assert.ok(!/<script/i.test(r.body), "server-rendered means no bundle and no script tag");
});

test("the ledger page reports chain health", async () => {
  const { app, ledger } = harness();
  ledger.append({ agent: "operator", tool: "fs.write", verb: "create", tier: "contained", authority: "envelope" });
  const r = await get(app, "/ui/ledger");
  assert.equal(r.status, 200);
  assert.match(r.body, /chain verifies/);
  assert.match(r.body, /fs\.write/);
});

test("an intent awaiting consent renders a decide form", async () => {
  const { app, intents, see } = harness();
  const { intent } = intents.propose({
    idempotencyKey: "k1", caller: see,
    body: { requested_outcome: "raise the incident invoice", detector: "traffic-anomaly" },
  });
  intents.awaitConsent(intent.id, { actionId: "act-1" });
  const r = await get(app, "/ui/intents");
  assert.match(r.body, /awaiting consent/);
  assert.match(r.body, /traffic-anomaly/);
  assert.ok(csrfFrom(r.body), "the form carries a csrf token");
});

test("a decision posted from the UI is recorded and ledgered", async () => {
  const { app, intents, ledger, see } = harness();
  const { intent } = intents.propose({ idempotencyKey: "k2", caller: see, body: { requested_outcome: "x" } });
  intents.awaitConsent(intent.id, { actionId: "act-1" });
  const csrf = csrfFrom((await get(app, "/ui/intents")).body);

  const r = await post(app, "/ui/decide", {
    csrf, intent_id: intent.id, action_id: "act-1",
    verdict: "approve", reason: "confirmed on the live feed",
  });
  assert.equal(r.status, 303, "redirect back to the list");
  assert.equal(intents.get(intent.id).decisions.length, 1);
  assert.ok(ledger.all().some((e) => e.tool === "ui.decide" && e.outcome === "recorded"));
});

test("a forged csrf token is refused", async () => {
  const { app, intents, see } = harness();
  const { intent } = intents.propose({ idempotencyKey: "k3", caller: see, body: { requested_outcome: "x" } });
  const r = await post(app, "/ui/decide", {
    csrf: "deadbeef", intent_id: intent.id, action_id: "act-1", verdict: "approve", reason: "nope",
  });
  assert.equal(r.status, 403);
  assert.equal(intents.get(intent.id).decisions.length, 0);
});
