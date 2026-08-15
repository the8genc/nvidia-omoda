import { test } from "node:test";
import assert from "node:assert/strict";
import { createIntentStore } from "../src/api/intents.js";
import { verifyDecision } from "../src/broker/decision.js";
import { VERB, IMPACT } from "../src/domain/taxonomy.js";

const see = { id: "see:cam3", scopes: ["intent:propose"] };
const alice = { id: "operator:alice", scopes: ["intent:decide"] };
const bob = { id: "operator:bob", scopes: ["intent:decide"] };

// A financial DELETE is the one kind that consentKind maps to "two-person".
const deleteAction = {
  actionId: "act-del", agent: "finance", tool: "quickbooks.invoice.delete",
  verb: VERB.DELETE, impact: [IMPACT.FINANCIAL], declared: true,
};

function twoOperatorStore() {
  const intents = createIntentStore({ singleOperator: false });
  const { intent } = intents.propose({ idempotencyKey: "k", caller: see, body: { requested_outcome: "void it" } });
  intents.awaitConsent(intent.id, deleteAction);
  return { intents, intent };
}

test("one approval on a two-person action does not settle it", () => {
  const { intents, intent } = twoOperatorStore();
  const r = intents.decide({
    intentId: intent.id, actionId: "act-del", verdict: "approve",
    reason: "looks right to me", caller: alice,
  });
  assert.equal(r.ok, true);
  assert.equal(r.quorum.needed, 2);
  assert.equal(r.quorum.have, 1);
  assert.equal(r.quorum.settled, false);
  assert.equal(r.decision.settled, false);
  assert.equal(intents.get(intent.id).state, "awaiting_consent");
});

test("verifyDecision refuses to execute a decision short of quorum", () => {
  const { intents, intent } = twoOperatorStore();
  const r = intents.decide({
    intentId: intent.id, actionId: "act-del", verdict: "approve",
    reason: "first approver", caller: alice,
  });
  const v = verifyDecision(r.decision, deleteAction);
  assert.equal(v.ok, false);
  assert.match(v.reason, /second approver/);
  assert.match(v.reason, /1\/2/);
});

test("a second DISTINCT approver settles it and yields an executable decision", () => {
  const { intents, intent } = twoOperatorStore();
  intents.decide({ intentId: intent.id, actionId: "act-del", verdict: "approve", reason: "alice ok", caller: alice });
  const second = intents.decide({ intentId: intent.id, actionId: "act-del", verdict: "approve", reason: "bob ok", caller: bob });
  assert.equal(second.ok, true);
  assert.equal(second.quorum.settled, true);
  assert.equal(second.decision.settled, true);
  assert.equal(intents.get(intent.id).state, "proposed");
  assert.equal(verifyDecision(second.decision, deleteAction).ok, true);
});

test("the same approver cannot form a quorum by approving twice", () => {
  const { intents, intent } = twoOperatorStore();
  intents.decide({ intentId: intent.id, actionId: "act-del", verdict: "approve", reason: "once", caller: alice });
  const again = intents.decide({ intentId: intent.id, actionId: "act-del", verdict: "approve", reason: "twice", caller: alice });
  assert.equal(again.ok, false);
  assert.equal(again.status, 409);
  assert.match(again.reason, /distinct people/);
  assert.equal(intents.get(intent.id).state, "awaiting_consent");
});

test("the proposer still cannot be either half of the pair", () => {
  const intents = createIntentStore({ singleOperator: false });
  // The proposer here is an operator who then tries to also approve.
  const { intent } = intents.propose({ idempotencyKey: "k", caller: alice, body: { requested_outcome: "x" } });
  intents.awaitConsent(intent.id, deleteAction);
  const r = intents.decide({ intentId: intent.id, actionId: "act-del", verdict: "approve", reason: "self", caller: alice });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test("a single-operator deployment fails a two-person action closed", () => {
  const intents = createIntentStore({ singleOperator: true });
  const { intent } = intents.propose({ idempotencyKey: "k", caller: see, body: { requested_outcome: "void it" } });
  intents.awaitConsent(intent.id, deleteAction);
  const r = intents.decide({ intentId: intent.id, actionId: "act-del", verdict: "approve", reason: "only me", caller: alice });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.match(r.reason, /single operator/);
  assert.equal(intents.get(intent.id).decisions.length, 0, "nothing recorded; it failed closed");
});

test("an ordinary financial write still settles on one approval, single operator or not", () => {
  const createAction = {
    actionId: "act-new", tool: "quickbooks.invoice.create",
    verb: VERB.CREATE, impact: [IMPACT.FINANCIAL], declared: true,
  };
  for (const singleOperator of [true, false]) {
    const intents = createIntentStore({ singleOperator });
    const { intent } = intents.propose({ idempotencyKey: "k", caller: see, body: {} });
    intents.awaitConsent(intent.id, createAction);
    const r = intents.decide({ intentId: intent.id, actionId: "act-new", verdict: "approve", reason: "raise it", caller: alice });
    assert.equal(r.ok, true, `singleOperator=${singleOperator}`);
    assert.equal(r.decision.settled, true);
    assert.equal(intents.get(intent.id).state, "proposed");
    assert.equal(verifyDecision(r.decision, createAction).ok, true);
  }
});

test("one deny stops a two-person action without waiting for a second voice", () => {
  const { intents, intent } = twoOperatorStore();
  const r = intents.decide({ intentId: intent.id, actionId: "act-del", verdict: "deny", reason: "not this one", caller: alice });
  assert.equal(r.ok, true);
  assert.equal(intents.get(intent.id).state, "denied");
  const after = intents.decide({ intentId: intent.id, actionId: "act-del", verdict: "approve", reason: "override", caller: bob });
  assert.equal(after.ok, false, "a denied action is final");
  assert.equal(after.status, 409);
});
