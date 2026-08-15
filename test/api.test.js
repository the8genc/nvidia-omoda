import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/api/server.js";
import { createTokenStore, createNonceCache, createRateLimiter, signBody, assertBindable } from "../src/api/auth.js";
import { createLedger } from "../src/ledger/ledger.js";
import { createIntentStore } from "../src/api/intents.js";

function harness() {
  const tokens = createTokenStore();
  // The See project: propose ONLY. This is the security keystone.
  const see = tokens.issue({ id: "see:cam3", scopes: ["intent:propose"] });
  const op = tokens.issue({ id: "operator:arif", scopes: ["intent:propose", "intent:read", "intent:decide", "ledger:read", "control:halt"] });
  const app = createApp({
    tokens,
    ledger: createLedger({ path: `/tmp/omoda-api-${Date.now()}-${Math.random()}.jsonl` }),
    intents: createIntentStore(),
    nonces: createNonceCache(),
    limiter: createRateLimiter({ capacity: 1000 }),
  });
  return { app, see, op };
}

/** Drive the handler directly; no socket needed. */
async function call(app, { method = "GET", path, token, body, idem, skewSec = 0, sig }) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000) + skewSec;
  const headers = { authorization: token ? `Bearer ${token.token}` : undefined };
  if (method === "POST") {
    headers["x-omoda-timestamp"] = String(ts);
    headers["x-omoda-signature"] = sig ?? signBody(token.secret, ts, raw);
    if (idem) headers["idempotency-key"] = idem;
  }
  const chunks = raw ? [Buffer.from(raw)] : [];
  const req = { method, url: path, headers, async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; } };
  let status, payload;
  const res = {
    writeHead(s) { status = s; },
    end(b) { try { payload = JSON.parse(b); } catch { payload = b; } },
  };
  await app.handle(req, res);
  return { status, body: payload };
}

const propose = { kind: "detection", detector: "d1", confidence: 0.9, evidence: { camera: "cam3" }, requested_outcome: "run the standard response" };

test("healthz needs no auth", async () => {
  const { app } = harness();
  assert.equal((await call(app, { path: "/healthz" })).status, 200);
});

test("propose returns 202 with an intent id, never 200 executed", async () => {
  const { app, see } = harness();
  const r = await call(app, { method: "POST", path: "/v1/intents", token: see, body: propose, idem: "k1" });
  assert.equal(r.status, 202, "202 Accepted: proposing is not doing");
  assert.match(r.body.intent_id, /^int_/);
});

test("S4: the Idempotency-Key is mandatory and deduplicates", async () => {
  const { app, see } = harness();
  const missing = await call(app, { method: "POST", path: "/v1/intents", token: see, body: propose });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, "idempotency_required");

  const a = await call(app, { method: "POST", path: "/v1/intents", token: see, body: propose, idem: "same" });
  const b = await call(app, { method: "POST", path: "/v1/intents", token: see, body: propose, idem: "same" });
  assert.equal(a.body.intent_id, b.body.intent_id, "a retrying detector must not create two intents");
  assert.equal(b.body.duplicate, true);
});

test("S1 KEYSTONE: a propose-only token cannot record a decision", async () => {
  const { app, see } = harness();
  const created = await call(app, { method: "POST", path: "/v1/intents", token: see, body: propose, idem: "k2" });
  const r = await call(app, {
    method: "POST", path: `/v1/intents/${created.body.intent_id}/decisions`,
    token: see, body: { verdict: "approve", reason: "looks fine to me", action_id: "act-1" },
  });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "scope");
});

test("S2: even with the right scope, the proposer cannot decide", async () => {
  const { app, op } = harness();
  const created = await call(app, { method: "POST", path: "/v1/intents", token: op, body: propose, idem: "k3" });
  const r = await call(app, {
    method: "POST", path: `/v1/intents/${created.body.intent_id}/decisions`,
    token: op, body: { verdict: "approve", reason: "self approving", action_id: "act-1" },
  });
  assert.equal(r.status, 403);
  assert.match(r.body.message, /separation of duties/);
});

test("the operator can decide on a See-proposed intent, and only once", async () => {
  const { app, see, op } = harness();
  const created = await call(app, { method: "POST", path: "/v1/intents", token: see, body: propose, idem: "k4" });
  const ok = await call(app, {
    method: "POST", path: `/v1/intents/${created.body.intent_id}/decisions`,
    token: op, body: { verdict: "approve", reason: "confirmed on the live feed", action_id: "act-1" },
  });
  assert.equal(ok.status, 201);
  const again = await call(app, {
    method: "POST", path: `/v1/intents/${created.body.intent_id}/decisions`,
    token: op, body: { verdict: "approve", reason: "again", action_id: "act-1" },
  });
  assert.equal(again.status, 409, "a second decision for the same action is refused");
});

test("a decision requires a reason", async () => {
  const { app, see, op } = harness();
  const created = await call(app, { method: "POST", path: "/v1/intents", token: see, body: propose, idem: "k5" });
  const r = await call(app, {
    method: "POST", path: `/v1/intents/${created.body.intent_id}/decisions`,
    token: op, body: { verdict: "approve", reason: "   ", action_id: "act-1" },
  });
  assert.equal(r.status, 422);
});

test("S3: a bad signature, a stale timestamp, and a replay are each refused", async () => {
  const { app, see } = harness();
  const bad = await call(app, { method: "POST", path: "/v1/intents", token: see, body: propose, idem: "k6", sig: "sha256=deadbeef" });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error, "bad_signature");

  const stale = await call(app, { method: "POST", path: "/v1/intents", token: see, body: propose, idem: "k7", skewSec: -600 });
  assert.equal(stale.status, 401);
  assert.equal(stale.body.error, "stale");

  const ts = Math.floor(Date.now() / 1000);
  const raw = JSON.stringify(propose);
  const sig = signBody(see.secret, ts, raw);
  const once = await call(app, { method: "POST", path: "/v1/intents", token: see, body: propose, idem: "k8", sig });
  assert.equal(once.status, 202);
  const twice = await call(app, { method: "POST", path: "/v1/intents", token: see, body: propose, idem: "k9", sig });
  assert.equal(twice.status, 409, "the same signature cannot be used twice");
});

test("S5: unknown fields are rejected, not ignored", async () => {
  const { app, see } = harness();
  const r = await call(app, {
    method: "POST", path: "/v1/intents", token: see, idem: "k10",
    body: { ...propose, exec: "rm -rf /" },
  });
  assert.equal(r.status, 422);
});

test("an unknown or missing token is refused", async () => {
  const { app } = harness();
  assert.equal((await call(app, { path: "/v1/ledger" })).status, 401);
});

test("the ledger endpoint returns a verifying chain", async () => {
  const { app, see, op } = harness();
  await call(app, { method: "POST", path: "/v1/intents", token: see, body: propose, idem: "k11" });
  const r = await call(app, { path: "/v1/ledger", token: op });
  assert.equal(r.status, 200);
  assert.equal(r.body.chain.ok, true);
  assert.ok(r.body.entries.length >= 1);
});

test("S11: refuses to bind outside the port block or on a public interface", () => {
  assert.throws(() => assertBindable(8080, "127.0.0.1"), /outside our block/);
  assert.throws(() => assertBindable(3110, "0.0.0.0"), /not public/);
  assert.equal(assertBindable(3110, "127.0.0.1"), true);
});
