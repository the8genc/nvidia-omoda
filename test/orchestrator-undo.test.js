import { test } from "node:test";
import assert from "node:assert/strict";
import { createOrchestrator } from "../src/orchestrator.js";
import { createUndoStore } from "../src/broker/undo.js";
import { authorize } from "../src/broker/authorize.js";
import { createIntentStore } from "../src/api/intents.js";
import { createLedger } from "../src/ledger/ledger.js";
import { buildCapabilityIndex, loadSkills } from "../src/skills/load.js";
import { VERB, IMPACT } from "../src/domain/taxonomy.js";
import { MODEL, ENDPOINT } from "../src/models/router.js";

const registry = buildCapabilityIndex(loadSkills().skills);
const ledger = () => createLedger({ path: `/tmp/omoda-orch-${Date.now()}-${Math.random()}.jsonl` });
const client = (tool) => ({ async complete() { return { text: JSON.stringify({ tool, reason: "fits the request" }), model: MODEL.OMNI, endpoint: ENDPOINT.LOCAL }; } });

// ── L0 wired into the standing intake loop ────────────────────────────────
test("a proposed intent is automatically routed to a declared capability, awaiting consent", async () => {
  const intents = createIntentStore();
  const orch = createOrchestrator({ intents, registry, ledger: ledger(), client: client("quickbooks.invoice.create") });
  intents.onPropose = null; // wire manually for determinism
  const { intent } = intents.propose({ idempotencyKey: "k1", caller: { id: "see:cam", scopes: ["intent:propose"] }, body: { requested_outcome: "raise the incident invoice" } });
  const r = await orch.onIntent(intent);
  assert.equal(r.routed, true);
  assert.equal(r.tool, "quickbooks.invoice.create");
  assert.equal(r.consent, "approval");
  const after = intents.get(intent.id);
  assert.equal(after.actions.length, 1, "an action now awaits consent");
  assert.equal(after.actions[0].tool, "quickbooks.invoice.create");
});

test("the onPropose hook fires L0 on every intake, and never on a duplicate", async () => {
  let calls = 0;
  const intents = createIntentStore({ onPropose: () => { calls += 1; } });
  intents.propose({ idempotencyKey: "dup", caller: { id: "x", scopes: [] }, body: {} });
  intents.propose({ idempotencyKey: "dup", caller: { id: "x", scopes: [] }, body: {} }); // duplicate
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls, 1, "routed once, not on the redelivery");
});

test("L0 refuses when the model names an undeclared tool; nothing is awaited", async () => {
  const intents = createIntentStore();
  const orch = createOrchestrator({ intents, registry, ledger: ledger(), client: client("shell.exec") });
  const { intent } = intents.propose({ idempotencyKey: "k2", caller: { id: "x", scopes: [] }, body: { requested_outcome: "delete everything" } });
  const r = await orch.onIntent(intent);
  assert.equal(r.routed, false);
  assert.match(r.reason, /undeclared/);
  assert.equal(intents.get(intent.id).actions.length, 0);
});

test("L0 is idempotent: an already-routed intent is not routed again", async () => {
  const intents = createIntentStore();
  const orch = createOrchestrator({ intents, registry, ledger: ledger(), client: client("quickbooks.invoice.read") });
  const { intent } = intents.propose({ idempotencyKey: "k3", caller: { id: "x", scopes: [] }, body: { requested_outcome: "check the invoice" } });
  await orch.onIntent(intent);
  const second = await orch.onIntent(intent);
  assert.equal(second.routed, false);
  assert.match(second.reason, /already routed/);
});

test("L0 selects the tool but never the danger: verb and impact come from the manifest", async () => {
  const intents = createIntentStore();
  const orch = createOrchestrator({ intents, registry, ledger: ledger(), client: client("quickbooks.invoice.void") });
  const { intent } = intents.propose({ idempotencyKey: "k4", caller: { id: "x", scopes: [] }, body: { requested_outcome: "void it" } });
  await orch.onIntent(intent);
  const action = intents.get(intent.id).actions[0];
  assert.equal(action.verb, VERB.DELETE, "verb is the manifest's");
  assert.deepEqual([...action.impact].sort(), ["financial", "legal"]);
  assert.ok(action.inverse, "a destructive verb carries an inverse spec for UNDO");
});

// ── UNDO made real ────────────────────────────────────────────────────────
test("a contained write with an inverse registers a runnable undo", async () => {
  const led = ledger();
  const undo = createUndoStore({ ledger: led });
  let reversed = false;
  const action = { agent: "builder", tool: "fs.write", verb: VERB.UPDATE, impact: [], declared: true, inverse: { snapshot: "before" } };
  const out = await authorize(action, {
    ledger: led, undo,
    execute: async () => ({ ok: true }),
    executeInverse: async () => { reversed = true; return { restored: true }; },
  });
  assert.ok(out.undoToken, "an undo token is returned");
  assert.equal(undo.has(out.undoToken), true);

  const r = await undo.run(out.undoToken, { operator: "operator:arif" });
  assert.equal(r.ok, true);
  assert.equal(reversed, true, "the registered inverse actually ran");
  assert.ok(led.all().some((e) => e.kind === "undo" && e.outcome === "undone"));
});

test("undo is single-use, and an unknown token is refused", async () => {
  const led = ledger();
  const undo = createUndoStore({ ledger: led });
  const action = { agent: "b", tool: "fs.write", verb: VERB.UPDATE, impact: [], declared: true, inverse: { snapshot: "x" } };
  const out = await authorize(action, { ledger: led, undo, execute: async () => ({}), executeInverse: async () => ({}) });
  assert.equal((await undo.run(out.undoToken)).ok, true);
  const again = await undo.run(out.undoToken);
  assert.equal(again.ok, false);
  assert.match(again.reason, /already run/);
  assert.equal((await undo.run("nope")).ok, false);
});

test("a failed reversal can be retried and is recorded as failed", async () => {
  const led = ledger();
  const undo = createUndoStore({ ledger: led });
  let attempts = 0;
  const action = { agent: "b", tool: "fs.write", verb: VERB.UPDATE, impact: [], declared: true, inverse: {} };
  const out = await authorize(action, {
    ledger: led, undo, execute: async () => ({}),
    executeInverse: async () => { attempts += 1; if (attempts === 1) throw new Error("gateway down"); return { ok: true }; },
  });
  const first = await undo.run(out.undoToken);
  assert.equal(first.ok, false);
  assert.match(first.reason, /gateway down/);
  const retry = await undo.run(out.undoToken);
  assert.equal(retry.ok, true, "a failed reversal is retryable, not spent");
  assert.ok(led.all().some((e) => e.outcome === "undo-failed"));
});

test("a consequential write also registers its undo once executed under a decision", async () => {
  const led = ledger();
  const undo = createUndoStore({ ledger: led });
  const policy = { async applyDelta() { return { added: true }; }, async revertDelta() {}, check: () => ({ status: 200 }) };
  const action = {
    actionId: "a1", agent: "finance", tool: "quickbooks.invoice.void",
    verb: VERB.DELETE, impact: [IMPACT.FINANCIAL], declared: true, inverse: { restore: "INV-1" },
    request: { host: "quickbooks.api.intuit.com", method: "POST", path: "/void" },
  };
  const decision = { decisionId: "d1", actionId: "a1", verdict: "approve", reason: "ok", decidedBy: "op", proposedBy: "see", scopes: ["intent:decide"], spent: false, settled: true, expiresAt: Date.now() + 60_000 };
  const out = await authorize(action, { ledger: led, undo, policy, decision, execute: async () => ({ voided: "INV-1" }), executeInverse: async () => ({ restored: "INV-1" }) });
  assert.ok(out.undoToken);
  assert.equal((await undo.run(out.undoToken)).ok, true);
});
