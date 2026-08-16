// The undo registry: what makes UNDO real rather than a promise.
//
// A contained or consequential write that carries an inverse registers a replay
// here at execution time, keyed by the token the operator sees (the action's
// ledger hash prefix). UNDO <token> looks it up and runs the registered inverse
// through the ledger, exactly once.
//
// The inverse is itself an action, so running it is not a bypass of governance:
// it is ledgered like any other, and a create's inverse (a delete of what was
// created) still passes back through the Broker at the call site if the replay
// is written that way. The registry's job is only to hold the reversal and
// guarantee it happens at most once.

export function createUndoStore({ ledger } = {}) {
  const byToken = new Map(); // token -> { action, inverse, replay, spent, at }

  return {
    /**
     * Called by the Broker when a reversible write executes.
     * @param {object} e
     * @param {string} e.token       the undo token (action ledger hash prefix)
     * @param {object} e.action      the original action, for the record
     * @param {object} e.inverse     the registered inverse spec
     * @param {Function} [e.replay]  performs the reversal; returns its result
     */
    register({ token, action, inverse, replay = null }) {
      if (!token) return;
      byToken.set(token, { action, inverse, replay, spent: false, at: Date.now() });
    },

    has(token) { return byToken.has(token); },

    /**
     * Run the reversal for a token, once.
     * @returns {Promise<{ok:boolean, reason?:string, result?:unknown}>}
     */
    async run(token, { operator = "operator" } = {}) {
      const rec = byToken.get(token);
      if (!rec) return { ok: false, reason: `no reversible action for token ${token}` };
      if (rec.spent) return { ok: false, reason: `undo for ${token} was already run` };
      rec.spent = true;

      let result = null;
      try {
        result = rec.replay ? await rec.replay(rec.action, rec.inverse) : { replayed: rec.inverse };
      } catch (err) {
        rec.spent = false; // a failed reversal may be retried
        try {
          ledger?.append({ kind: "undo", agent: operator, tool: rec.action?.tool ?? "unknown", verb: "delete", outcome: "undo-failed", reason: err.message.slice(0, 160), undoToken: token });
        } catch { /* the failure record is best effort */ }
        return { ok: false, reason: `reversal failed: ${err.message}` };
      }

      try {
        ledger?.append({
          kind: "undo", agent: operator, tool: rec.action?.tool ?? "unknown", verb: "delete",
          outcome: "undone", reason: `reversed ${rec.action?.tool ?? "action"}`, undoToken: token,
        });
      } catch (err) {
        return { ok: false, reason: `reversal ran but could not be logged: ${err.message}` };
      }
      return { ok: true, result };
    },

    get size() { return byToken.size; },
  };
}
