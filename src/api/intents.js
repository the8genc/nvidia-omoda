// Intent store and lifecycle.
//
// An intent is a REQUEST for work, never the work itself. Proposing returns 202
// with an id; it never returns "executed". That distinction is the difference
// between an API and a remote code execution service.

import { randomUUID, createHash } from "node:crypto";

export const INTENT_STATE = Object.freeze({
  PROPOSED: "proposed",
  AWAITING_CONSENT: "awaiting_consent",
  EXECUTED: "executed",
  REFUSED: "refused",
  DENIED: "denied",
});

export function createIntentStore() {
  const byId = new Map();
  const byIdemKey = new Map();
  const decisionsSpent = new Set();

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
      if (decisionsSpent.has(key)) {
        return { ok: false, status: 409, reason: "a decision for this action was already recorded" };
      }
      decisionsSpent.add(key);

      const decision = {
        decisionId: `dec_${randomUUID()}`,
        actionId,
        verdict,
        reason,
        decidedBy: caller.id,
        proposedBy: intent.proposedBy,
        scopes: caller.scopes,
        spent: false,
        expiresAt: Date.now() + 120_000, // the delta window, section 22 item 6
        at: new Date().toISOString(),
      };
      intent.decisions.push(decision);
      intent.state = verdict === "approve" ? INTENT_STATE.PROPOSED : INTENT_STATE.DENIED;
      return { ok: true, decision, intent };
    },

    /** Dedupe key for stream events with no Idempotency-Key header. */
    contentKey(payload) {
      return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24);
    },
  };
}
