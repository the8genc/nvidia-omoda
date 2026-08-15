// Intent store and lifecycle.
//
// An intent is a REQUEST for work, never the work itself. Proposing returns 202
// with an id; it never returns "executed". That distinction is the difference
// between an API and a remote code execution service.

import { randomUUID, createHash } from "node:crypto";
import { consentKind } from "../domain/taxonomy.js";

export const INTENT_STATE = Object.freeze({
  PROPOSED: "proposed",
  AWAITING_CONSENT: "awaiting_consent",
  EXECUTED: "executed",
  REFUSED: "refused",
  DENIED: "denied",
});

/**
 * @param {object} [opts]
 * @param {boolean} [opts.singleOperator=false] When true, this deployment has
 *   exactly one operator identity, so a two-person action can never gather a
 *   second distinct approver. Rather than accept one tap and pretend the rule
 *   held, we fail closed and say why. Set it from the size of the operator
 *   allowlist at boot.
 */
export function createIntentStore({ singleOperator = false } = {}) {
  const byId = new Map();
  const byIdemKey = new Map();
  // An action is "final" once it settles (approved) or is denied. A final
  // action refuses further decisions. Two-person actions are NOT final on the
  // first approval; they collect approvers until quorum.
  const finalActions = new Set();
  const approversByAction = new Map();

  const quorumFor = (kind) => (kind === "two-person" ? 2 : 1);

  const mkDecision = ({ actionId, verdict, reason, caller, intent, settled, needed, have }) => ({
    decisionId: `dec_${randomUUID()}`,
    actionId,
    verdict,
    reason,
    decidedBy: caller.id,
    proposedBy: intent.proposedBy,
    scopes: caller.scopes,
    spent: false,
    // A decision short of quorum exists in the record but is not executable.
    // verifyDecision refuses it until a second distinct approver settles it.
    settled,
    quorum: { needed, have },
    expiresAt: Date.now() + 120_000, // the delta window, section 22 item 6
    at: new Date().toISOString(),
  });

  return {
    /** S4: the same Idempotency-Key always returns the same intent. */
    propose({ idempotencyKey, body, caller }) {
      if (idempotencyKey && byIdemKey.has(idempotencyKey)) {
        return { intent: byIdemKey.get(idempotencyKey), duplicate: true };
      }
      const intent = {
        id: `int_${randomUUID()}`,
        state: INTENT_STATE.PROPOSED,
        proposedBy: caller.id,
        source: body.source ?? caller.id,
        kind: body.kind ?? "task",
        detector: body.detector ?? null,
        confidence: body.confidence ?? null,
        observedAt: body.observed_at ?? null,
        evidence: body.evidence ?? {},
        requestedOutcome: body.requested_outcome ?? null,
        actions: [],
        decisions: [],
        createdAt: new Date().toISOString(),
      };
      byId.set(intent.id, intent);
      if (idempotencyKey) byIdemKey.set(idempotencyKey, intent);
      return { intent, duplicate: false };
    },

    get(id) { return byId.get(id) ?? null; },
    all() { return [...byId.values()]; },

    /** Register a pending consequential action awaiting consent. */
    awaitConsent(intentId, action) {
      const intent = byId.get(intentId);
      if (!intent) return null;
      intent.state = INTENT_STATE.AWAITING_CONSENT;
      intent.actions.push({ ...action, state: "awaiting_consent" });
      return intent;
    },

    /**
     * Record a decision. Enforces S2 (proposer cannot decide) and S7 (single use)
     * at the store level, so neither depends on the caller behaving.
     */
    decide({ intentId, actionId, verdict, reason, caller }) {
      const intent = byId.get(intentId);
      if (!intent) return { ok: false, status: 404, reason: "unknown intent" };
      if (!reason || !String(reason).trim()) {
        return { ok: false, status: 422, reason: "a decision requires a reason" };
      }
      if (caller.id === intent.proposedBy) {
        return { ok: false, status: 403, reason: "separation of duties: the proposer cannot decide" };
      }
      const key = `${intentId}:${actionId}`;
      if (finalActions.has(key)) {
        return { ok: false, status: 409, reason: "a decision for this action was already recorded" };
      }

      // How much consent this action needs is a property of the action, derived
      // from its CRUD verb and blast domain, not something the decider chooses.
      const action = intent.actions.find((a) => a.actionId === actionId);
      const kind = action ? consentKind(action.verb, action.impact) ?? "approval" : "approval";
      const needed = quorumFor(kind);

      // A deny is final immediately, whatever the quorum: one refusal stops it.
      if (verdict !== "approve") {
        finalActions.add(key);
        const decision = mkDecision({ actionId, verdict, reason, caller, intent, settled: true, needed, have: 0 });
        intent.decisions.push(decision);
        intent.state = INTENT_STATE.DENIED;
        return { ok: true, decision, intent };
      }

      // Two-person with a single operator can never gather a second approver.
      // Accepting one tap here would let an unenforceable rule look satisfied.
      if (kind === "two-person" && singleOperator) {
        return {
          ok: false, status: 409,
          reason: "two-person consent required, but this deployment runs a single operator; a second distinct approver cannot exist. Add a second operator or reclassify the action.",
        };
      }

      const approvers = approversByAction.get(key) ?? new Set();
      if (approvers.has(caller.id)) {
        return { ok: false, status: 409, reason: "this approver has already approved this action; a quorum needs distinct people" };
      }
      approvers.add(caller.id);
      approversByAction.set(key, approvers);

      const have = approvers.size;
      const settled = have >= needed;
      const decision = mkDecision({ actionId, verdict, reason, caller, intent, settled, needed, have });
      intent.decisions.push(decision);

      if (settled) {
        finalActions.add(key);
        intent.state = INTENT_STATE.PROPOSED;
      } else {
        // Still short of quorum. The action stays open for another distinct
        // approver, and this decision is not executable on its own.
        intent.state = INTENT_STATE.AWAITING_CONSENT;
      }
      return { ok: true, decision, intent, quorum: { needed, have, settled } };
    },

    /** Dedupe key for stream events with no Idempotency-Key header. */
    contentKey(payload) {
      return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24);
    },
  };
}
