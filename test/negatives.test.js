// SAFETY NEGATIVES. These are written before the Broker exists and must be
// RED until the 13:00 consent-loop block turns them green.
//
// Every test here asserts something the system must REFUSE. A green suite
// here is the only evidence that the safety property holds; the happy path
// proves nothing about a gate.
//
// PRD section 18.1.

import { test } from "node:test";
import assert from "node:assert/strict";
import { authorize } from "../src/broker/authorize.js";
import { VERB, IMPACT } from "../src/domain/taxonomy.js";

/** A decision that is genuine in every respect. Present in the prohibited
 *  tests deliberately: a valid decision must NOT unlock a prohibited action. */
const validDecision = {
  decisionId: "dec-1",
  actionId: "act-1",
  verdict: "approve",
  reason: "operator confirmed",
  decidedBy: "operator:arif",
  proposedBy: "see:cam3",
  spent: false,
  expiresAt: Date.now() + 120_000,
};

async function outcome(action, ctx = {}) {
  try {
    return await authorize(action, ctx);
  } catch (err) {
    return { status: "threw", reason: err.name, message: err.message };
  }
}

test("prohibited: the shared vLLM is refused even WITH a valid decision", async () => {
  const r = await outcome(
    { tool: "shell.exec", verb: VERB.UPDATE, port: 8000, args: { cmd: "docker restart nemotron-omni" } },
    { decision: validDecision },
  );
  assert.equal(r.status, "refused");
  assert.equal(r.tier, "prohibited");
});

test("prohibited: a bind outside 3100-3199 is refused", async () => {
  const r = await outcome({ tool: "net.listen", verb: VERB.CREATE, port: 3250 });
  assert.equal(r.status, "refused");
  assert.equal(r.tier, "prohibited");
});

test("prohibited: the self-protection clause holds against a valid decision", async () => {
  const r = await outcome(
    { tool: "policy.propose", verb: VERB.UPDATE, policyDelta: { exclude: ["managed_inference"] } },
    { decision: validDecision },
  );
  assert.equal(r.status, "refused");
  assert.equal(r.tier, "prohibited");
});

test("undeclared: a tool absent from every manifest never executes", async () => {
  const r = await outcome({ tool: "quickbooks.payroll.run", verb: VERB.CREATE, declared: false });
  assert.equal(r.status, "refused");
  assert.equal(r.tier, "undeclared");
});

test("consequential: a financial write with NO decision does not execute", async () => {
  const r = await outcome({
    tool: "quickbooks.invoice.create",
    verb: VERB.CREATE,
    impact: [IMPACT.FINANCIAL],
    declared: true,
  });
  assert.equal(r.status, "escalated", "it must open a consent stage, not execute");
  assert.notEqual(r.status, "executed");
});

test("separation of duties: the proposer cannot be the decider", async () => {
  const selfApproved = { ...validDecision, decidedBy: "see:cam3", proposedBy: "see:cam3" };
  const r = await outcome(
    { tool: "quickbooks.invoice.create", verb: VERB.CREATE, impact: [IMPACT.FINANCIAL], declared: true },
    { decision: selfApproved },
  );
  assert.equal(r.status, "refused");
  assert.match(r.reason ?? "", /separation|self/i);
});

test("a spent decision cannot be replayed", async () => {
  const r = await outcome(
    { tool: "quickbooks.invoice.create", verb: VERB.CREATE, impact: [IMPACT.FINANCIAL], declared: true },
    { decision: { ...validDecision, spent: true } },
  );
  assert.equal(r.status, "refused");
  assert.match(r.reason ?? "", /spent|replay/i);
});

test("an expired decision does not unlock the capability", async () => {
  const r = await outcome(
    { tool: "quickbooks.invoice.create", verb: VERB.CREATE, impact: [IMPACT.FINANCIAL], declared: true },
    { decision: { ...validDecision, expiresAt: Date.now() - 1 } },
  );
  assert.equal(r.status, "refused");
  assert.match(r.reason ?? "", /expired/i);
});

test("a decision bound to a different action is refused", async () => {
  const r = await outcome(
    { actionId: "act-2", tool: "quickbooks.invoice.create", verb: VERB.CREATE, impact: [IMPACT.FINANCIAL], declared: true },
    { decision: validDecision }, // bound to act-1
  );
  assert.equal(r.status, "refused");
  assert.match(r.reason ?? "", /bound|mismatch/i);
});

test("update with no registered inverse is refused, not downgraded", async () => {
  const r = await outcome({
    tool: "fs.write", verb: VERB.UPDATE, impact: [], declared: true, inverse: null,
  });
  assert.equal(r.status, "refused");
  assert.match(r.reason ?? "", /inverse/i);
});

test("fail closed: a ledger write failure refuses the action", async () => {
  const r = await outcome(
    { tool: "fs.write", verb: VERB.CREATE, impact: [], declared: true },
    { ledgerBroken: true },
  );
  assert.equal(r.status, "refused");
  assert.match(r.reason ?? "", /ledger/i);
});

test("stream input cannot consent: intent:propose scope may not decide", async () => {
  const r = await outcome(
    { tool: "quickbooks.invoice.create", verb: VERB.CREATE, impact: [IMPACT.FINANCIAL], declared: true },
    { decision: { ...validDecision, decidedBy: "see:cam3", scopes: ["intent:propose"] } },
  );
  assert.equal(r.status, "refused");
});
