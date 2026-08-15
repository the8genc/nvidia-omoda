// THE choke point. Every dangerous action in the system passes through here.
// One function to audit, one function to test.
//
// Order is load-bearing and deliberate:
//   1. prohibited   before anything else, so a valid decision cannot reach it
//   2. undeclared   before any permissive path, so omissions fail closed
//   3. ledger       BEFORE execute, so an unlogged action is impossible
//   4. dispatch     safe / contained / consequential
//
// Fails closed on every error path (S13).

import { prohibitedReason } from "../domain/prohibited.js";
import { classify, requiresInverse, TIER } from "../domain/taxonomy.js";
import { verifyDecision } from "./decision.js";
import { createLedger, hashArgs } from "../ledger/ledger.js";

const refused = (tier, reason, extra = {}) => ({ status: "refused", tier, reason, ...extra });
const escalated = (reason, extra = {}) => ({ status: "escalated", tier: TIER.CONSEQUENTIAL, reason, ...extra });
const executed = (tier, authority, extra = {}) => ({ status: "executed", tier, authority, ...extra });

/** A policy port. The real one shells out to openshell; tests inject a fake. */
const nullPolicy = {
  async applyDelta() { return { applied: true }; },
  async revertDelta() { return { reverted: true }; },
};

let defaultLedger = null;
function ledgerFor(ctx) {
  if (ctx.ledger) return ctx.ledger;
  if (ctx.ledgerBroken) return createLedger({ broken: true });
  if (!defaultLedger) defaultLedger = createLedger({});
  return defaultLedger;
}

/**
 * @param {object} action  { tool, verb, impact, declared, actionId, port, path, args,
 *                           policyDelta, inverse, agent }
 * @param {object} ctx     { decision, ledger, ledgerBroken, policy, execute, now }
 */
export async function authorize(action = {}, ctx = {}) {
  const ledger = ledgerFor(ctx);
  const policy = ctx.policy ?? nullPolicy;
  const execute = ctx.execute ?? (async () => ({ ok: true }));
  const now = ctx.now ?? Date.now();

  const base = {
    agent: action.agent ?? "unknown",
    tool: action.tool ?? "unknown",
    verb: action.verb,
    impact: action.impact ?? [],
    argsHash: hashArgs(action.args),
    actionId: action.actionId ?? null,
  };

  // Best-effort record. A refusal must still be evidence, but a ledger failure
  // must not turn a refusal into anything else.
  const record = (entry) => { try { return ledger.append({ ...base, ...entry }); } catch { return null; } };

  // 1. Prohibited. Checked before the envelope and before any consent logic, so
  //    a genuine, valid decision can never unlock it.
  const rule = prohibitedReason(action);
  if (rule) {
    record({ tier: TIER.PROHIBITED, authority: "prohibited", outcome: "refused", rule });
    return refused(TIER.PROHIBITED, `prohibited: ${rule}`, { rule, incident: true });
  }

  // 2. Undeclared is denied. No manifest entry means no capability.
  if (action.declared !== true) {
    record({ tier: TIER.UNDECLARED, authority: "denied", outcome: "refused" });
    return refused(TIER.UNDECLARED, "undeclared: tool is absent from every skill manifest");
  }

  const tier = classify({
    verb: action.verb,
    impact: action.impact ?? [],
    declared: true,
    prohibited: false,
  });

  if (tier === TIER.UNDECLARED) {
    record({ tier, authority: "denied", outcome: "refused" });
    return refused(TIER.UNDECLARED, `unknown verb: ${action.verb}`);
  }

  // 3. Ledger before execute. This one is REQUIRED, so a failure refuses.
  let entry;
  try {
    entry = ledger.append({ ...base, tier, authority: "pending", outcome: "admitted" });
  } catch (err) {
    return refused(tier, `ledger write failed, refusing to act unlogged: ${err.message}`);
  }

  // 4a. Reads are safe.
  if (tier === TIER.SAFE) {
    const out = await execute(action);
    record({ tier, authority: "envelope", outcome: "executed", ofSeq: entry.seq });
    return executed(tier, "envelope", { ledgerSeq: entry.seq, result: out });
  }

  // 4b. Contained writes: autonomous, but destructive verbs need a way back.
  if (tier === TIER.CONTAINED) {
    if (requiresInverse(action.verb) && !action.inverse) {
      return refused(tier, "no inverse registered: an update or delete must be reversible before it runs");
    }
    const out = await execute(action);
    record({ tier, authority: "envelope", outcome: "executed", ofSeq: entry.seq });
    return executed(tier, "envelope", { ledgerSeq: entry.seq, result: out, undoToken: action.inverse ? entry.hash.slice(0, 12) : null });
  }

  // 4c. Consequential writes. The capability does not exist yet.
  if (!ctx.decision) {
    return escalated("consequential write requires a recorded decision; capability is absent until then", {
      ledgerSeq: entry.seq,
      consentNeeded: true,
    });
  }

  const check = verifyDecision(ctx.decision, action, { now });
  if (!check.ok) {
    record({ tier, authority: "denied", outcome: "refused", reason: check.reason });
    return refused(tier, check.reason);
  }

  if (requiresInverse(action.verb) && !action.inverse) {
    return refused(tier, "no inverse registered: an update or delete must be reversible before it runs");
  }

  // The decision materializes the capability, narrowly and briefly.
  let delta = null;
  try {
    delta = await policy.applyDelta(action, ctx.decision);
    const out = await execute(action);
    record({
      tier,
      authority: `decision:${ctx.decision.decisionId}`,
      outcome: "executed",
      ofSeq: entry.seq,
      decidedBy: ctx.decision.decidedBy,
    });
    return executed(tier, `decision:${ctx.decision.decisionId}`, {
      ledgerSeq: entry.seq,
      result: out,
      deltaApplied: true,
    });
  } finally {
    // Guaranteed revert. A failed revert is an incident, not a log line.
    if (delta) {
      try {
        await policy.revertDelta(action, ctx.decision);
      } catch (err) {
        record({ tier, authority: "incident", outcome: "revert-failed", reason: err.message });
        throw new Error(`HALT: policy delta revert failed, capability may remain open: ${err.message}`);
      }
    }
  }
}
