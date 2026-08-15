// The positive half of the consent loop. The negatives prove we refuse;
// these prove the capability actually appears, is used, and then GOES AWAY.
// A delta that is applied and not reverted is the worst outcome in the system.

import { test } from "node:test";
import assert from "node:assert/strict";
import { authorize } from "../src/broker/authorize.js";
import { createLedger } from "../src/ledger/ledger.js";
import { VERB, IMPACT } from "../src/domain/taxonomy.js";

const financialWrite = {
  actionId: "act-1", agent: "finance", tool: "quickbooks.invoice.create",
  verb: VERB.CREATE, impact: [IMPACT.FINANCIAL], declared: true,
};

const goodDecision = {
  decisionId: "dec-1", actionId: "act-1", verdict: "approve",
  reason: "operator confirmed on the live feed",
  decidedBy: "operator:arif", proposedBy: "see:cam3",
  spent: false, expiresAt: Date.now() + 120_000, scopes: ["intent:decide"],
};

function spyPolicy(opts = {}) {
  const calls = [];
  return {
    calls,
    async applyDelta() { calls.push("apply"); if (opts.applyThrows) throw new Error("apply failed"); return { applied: true }; },
    async revertDelta() { calls.push("revert"); if (opts.revertThrows) throw new Error("gateway unreachable"); return { reverted: true }; },
  };
}

test("a verified decision materializes the capability, then revokes it", async () => {
  const policy = spyPolicy();
  const ledger = createLedger({ broken: false, path: `/tmp/omoda-${Date.now()}-a.jsonl` });
  const r = await authorize(financialWrite, { decision: goodDecision, policy, ledger, execute: async () => ({ ok: true, id: "inv-77" }) });

  assert.equal(r.status, "executed");
  assert.equal(r.tier, "consequential");
  assert.equal(r.authority, "decision:dec-1", "the ledger cites the decision, not the envelope");
  assert.equal(r.deltaApplied, true);
  assert.deepEqual(policy.calls, ["apply", "revert"], "applied then reverted, in that order");
});

test("the delta reverts even when the action itself fails", async () => {
  const policy = spyPolicy();
  const ledger = createLedger({ path: `/tmp/omoda-${Date.now()}-b.jsonl` });
  await assert.rejects(
    () => authorize(financialWrite, {
      decision: goodDecision, policy, ledger,
      execute: async () => { throw new Error("upstream 500"); },
    }),
    /upstream 500/,
  );
  assert.deepEqual(policy.calls, ["apply", "revert"], "a failed action must not leave the write open");
});

test("a failed revert halts rather than leaving the capability open", async () => {
  const policy = spyPolicy({ revertThrows: true });
  const ledger = createLedger({ path: `/tmp/omoda-${Date.now()}-c.jsonl` });
  await assert.rejects(
    () => authorize(financialWrite, { decision: goodDecision, policy, ledger, execute: async () => ({ ok: true }) }),
    /HALT: policy delta revert failed/,
  );
});

test("a safe read never touches policy at all", async () => {
  const policy = spyPolicy();
  const ledger = createLedger({ path: `/tmp/omoda-${Date.now()}-d.jsonl` });
  const r = await authorize(
    { agent: "scout", tool: "http.get", verb: VERB.READ, impact: [], declared: true },
    { policy, ledger },
  );
  assert.equal(r.status, "executed");
  assert.equal(r.tier, "safe");
  assert.equal(r.authority, "envelope");
  assert.deepEqual(policy.calls, [], "no delta for a read");
});

test("a contained write with an inverse runs unattended and offers UNDO", async () => {
  const ledger = createLedger({ path: `/tmp/omoda-${Date.now()}-e.jsonl` });
  const r = await authorize(
    { agent: "builder", tool: "fs.write", verb: VERB.UPDATE, impact: [], declared: true, inverse: { snapshot: "abc" } },
    { ledger },
  );
  assert.equal(r.status, "executed");
  assert.equal(r.tier, "contained");
  assert.equal(r.authority, "envelope");
  assert.ok(r.undoToken, "a reversible write hands back an UNDO token");
});

test("every admitted action is in the ledger before it runs, and the chain verifies", async () => {
  const ledger = createLedger({ path: `/tmp/omoda-${Date.now()}-f.jsonl` });
  await authorize({ agent: "scout", tool: "http.get", verb: VERB.READ, declared: true }, { ledger });
  await authorize(financialWrite, { decision: goodDecision, ledger, policy: spyPolicy() });
  await authorize({ tool: "shell.exec", verb: VERB.UPDATE, port: 8000, declared: true }, { ledger });
  assert.equal(ledger.verify().ok, true);
  const prohibited = ledger.all().filter((r) => r.tier === "prohibited");
  assert.equal(prohibited.length, 1, "the prohibited attempt is evidence, not a silent drop");
});
