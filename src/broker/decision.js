// Decision verification.
//
// Making consent materialize capability introduces an attack that did not exist
// before: decision forgery. If a decision is what creates the write method, then
// faking one is the whole game. Everything here exists to make that hard.
//
// Pure. No I/O, so it is cheap to test exhaustively.

export const DECISION_SCOPE = "intent:decide";

/**
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
export function verifyDecision(decision, action, { now = Date.now() } = {}) {
  if (!decision) return { ok: false, reason: "no decision recorded for this action" };

  if (decision.verdict !== "approve") {
    return { ok: false, reason: `decision verdict is ${decision.verdict}, not approve` };
  }

  // Bound to ONE action. A decision for act-1 must not unlock act-2.
  if (action?.actionId && decision.actionId !== action.actionId) {
    return { ok: false, reason: "decision is bound to a different action (mismatch)" };
  }

  // Single use.
  if (decision.spent) return { ok: false, reason: "decision already spent, replay refused" };

  // Time boxed.
  if (typeof decision.expiresAt === "number" && decision.expiresAt <= now) {
    return { ok: false, reason: "decision expired" };
  }

  // Separation of duties. The identity that proposed cannot be the one that
  // consents. This is the most likely real bug in any consent system, and it is
  // also what stops an untrusted perception feed approving its own actions.
  if (decision.decidedBy && decision.proposedBy && decision.decidedBy === decision.proposedBy) {
    return { ok: false, reason: "separation of duties: proposer cannot be the decider (self-approval)" };
  }

  // Scope. A propose-only identity may never decide, whatever else is true.
  if (Array.isArray(decision.scopes) && !decision.scopes.includes(DECISION_SCOPE)) {
    return { ok: false, reason: `decider lacks ${DECISION_SCOPE} scope` };
  }

  // A decision with no explanation is not a decision.
  if (!decision.reason || !String(decision.reason).trim()) {
    return { ok: false, reason: "decision requires a reason" };
  }

  return { ok: true };
}
