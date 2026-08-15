// The on-box policy port: the same interface the simulator implements, backed
// by the real nemoclaw and openshell CLIs.
//
// Documented round trip (needs OpenShell >= 0.0.72; the box runs 0.0.85):
//   nemoclaw <sandbox> policy get  > current.yaml
//   ...edit...
//   openshell policy set --policy current.yaml --wait <sandbox>
//   nemoclaw <sandbox> policy list           # confirm
//
// exec is injected so every path here is unit-testable without a sandbox, and
// so a dry run cannot accidentally touch the box.

import { parse, stringify } from "yaml";
import { createEnvelope } from "./envelope.js";

const DEFAULT_TTL_MS = 120_000;

export class PolicyApplyError extends Error {
  constructor(message) { super(message); this.name = "PolicyApplyError"; }
}
export class PolicyRevertError extends Error {
  constructor(message) { super(message); this.name = "PolicyRevertError"; }
}

/**
 * @param {object} opts
 * @param {string} opts.sandbox     nemoclaw sandbox name, e.g. "omoda"
 * @param {(cmd:string, args:string[], input?:string) => Promise<{code:number, stdout:string, stderr:string}>} opts.exec
 * @param {boolean} opts.dryRun     compute and log the delta, never apply it
 */
export function createOpenShellPolicy({ sandbox, exec, dryRun = false, ttlMs = DEFAULT_TTL_MS, now = () => Date.now() }) {
  if (!sandbox) throw new Error("createOpenShellPolicy requires a sandbox name");
  if (typeof exec !== "function") throw new Error("createOpenShellPolicy requires an exec function");

  const open = new Map(); // actionId -> { id, host, method, path, expiresAt }

  async function readPolicy() {
    // `policy-get`, hyphenated. The CLI takes `nemoclaw <sandbox> policy-get`;
    // `policy get` parses as an unknown action named "policy" and exits 1, which
    // this adapter then reported as a policy failure. It only surfaced when the
    // command was finally run against the real CLI on the box.
    const r = await exec("nemoclaw", [sandbox, "policy-get"]);
    if (r.code !== 0) throw new PolicyApplyError(`policy-get failed: ${r.stderr.trim() || r.code}`);
    try {
      return parse(r.stdout) ?? {};
    } catch (err) {
      throw new PolicyApplyError(`policy get returned unparseable yaml: ${err.message}`);
    }
  }

  async function writePolicy(doc) {
    if (dryRun) return { dryRun: true };
    const r = await exec("openshell", ["policy", "set", "--policy", "-", "--wait", sandbox], stringify(doc));
    if (r.code !== 0) throw new PolicyApplyError(`policy set failed: ${r.stderr.trim() || r.code}`);
    return { applied: true };
  }

  /** Read the live policy and evaluate a request against it. */
  async function check(request) {
    const doc = await readPolicy();
    return createEnvelope(doc).check(request);
  }

  function endpointFor(doc, host) {
    for (const group of Object.values(doc.network_policies ?? {})) {
      for (const ep of group.endpoints ?? []) if (ep.host === host) return ep;
    }
    return null;
  }

  return {
    sandbox,
    get openDeltas() { return [...open.values()]; },
    check,

    /**
     * Add exactly one method on one path. Tagged with the action id so a revert
     * removes this delta and nothing else, and stamped with an expiry so a
     * crashed Broker cannot leave the capability open indefinitely.
     */
    async applyDelta(action, decision) {
      const req = action.request;
      if (!req?.host || !req?.method || !req?.path) {
        throw new PolicyApplyError("applyDelta needs action.request {host, method, path}");
      }
      const doc = await readPolicy();
      const ep = endpointFor(doc, req.host);
      if (!ep) throw new PolicyApplyError(`refusing to widen an undeclared host: ${req.host}`);
      if (ep.protocol !== "rest") {
        // Without L7 inspection a "narrow" delta is meaningless, so refuse
        // rather than pretend the grant is scoped.
        throw new PolicyApplyError(`endpoint ${req.host} is not protocol:rest; a scoped delta cannot be enforced`);
      }

      const id = `omoda-delta-${action.actionId}`;
      ep.rules = ep.rules ?? [];
      ep.rules.push({ allow: { method: req.method, path: req.path }, __delta: id });

      await writePolicy(doc);
      const rec = { id, host: req.host, method: req.method, path: req.path, expiresAt: now() + ttlMs, decisionId: decision?.decisionId ?? null };
      open.set(action.actionId, rec);
      return { applied: true, ...rec, dryRun };
    },

    /**
     * Remove the delta and VERIFY it is gone by re-reading. A revert that
     * reports success without checking is how a write method quietly survives.
     */
    async revertDelta(action) {
      const rec = open.get(action.actionId);
      if (!rec) return { reverted: true, noop: true };

      const doc = await readPolicy();
      let removed = 0;
      for (const group of Object.values(doc.network_policies ?? {})) {
        for (const ep of group.endpoints ?? []) {
          const before = (ep.rules ?? []).length;
          ep.rules = (ep.rules ?? []).filter((r) => r.__delta !== rec.id);
          removed += before - ep.rules.length;
        }
      }
      await writePolicy(doc);
      open.delete(action.actionId);

      if (!dryRun) {
        const after = await check({ host: rec.host, method: rec.method, path: rec.path });
        if (after.allowed) {
          throw new PolicyRevertError(
            `delta ${rec.id} still grants ${rec.method} ${rec.host}${rec.path} after revert`,
          );
        }
      }
      return { reverted: true, removed };
    },

    /** Sweep anything past its TTL. Called on a timer and on HALT. */
    async expireStale() {
      const t = now();
      const stale = [...open.entries()].filter(([, r]) => r.expiresAt <= t);
      for (const [actionId] of stale) {
        await this.revertDelta({ actionId });
      }
      return { expired: stale.length };
    },

    /** HALT: close every open capability, immediately. */
    async revertAll() {
      const ids = [...open.keys()];
      for (const actionId of ids) await this.revertDelta({ actionId });
      return { reverted: ids.length };
    },
  };
}
