import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, stringify } from "yaml";
import { createOpenShellPolicy, PolicyApplyError, PolicyRevertError } from "../src/policy/openshell.js";

const QB = "quickbooks.api.intuit.com";

/** A fake box: holds a policy document and records the CLI calls made against it. */
function fakeBox({ protocol = "rest", breakRevert = false } = {}) {
  let doc = {
    network_policies: {
      qb: {
        name: "qb",
        endpoints: [{
          host: QB, port: 443, protocol, enforcement: "enforce",
          rules: [{ allow: { method: "GET", path: "/v3/company/**" } }],
        }],
      },
    },
  };
  const calls = [];
  const exec = async (cmd, args, input) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    if (cmd === "nemoclaw" && args.includes("get")) {
      return { code: 0, stdout: stringify(doc), stderr: "" };
    }
    if (cmd === "openshell" && args.includes("set")) {
      const next = parse(input);
      // Simulate a box that accepts the write but silently does not apply it.
      if (!breakRevert) doc = next;
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected ${cmd}` };
  };
  return { exec, calls, get doc() { return doc; } };
}

const action = {
  actionId: "act-1",
  request: { host: QB, method: "POST", path: "/v3/company/42/invoice" },
};

test("a POST is absent from the live policy before any decision", async () => {
  const box = fakeBox();
  const p = createOpenShellPolicy({ sandbox: "omoda", exec: box.exec });
  const r = await p.check(action.request);
  assert.equal(r.allowed, false);
  assert.equal(r.status, 403);
});

test("applyDelta adds exactly one method and the round trip uses the documented CLIs", async () => {
  const box = fakeBox();
  const p = createOpenShellPolicy({ sandbox: "omoda", exec: box.exec });
  await p.applyDelta(action, { decisionId: "dec-1" });

  assert.equal((await p.check(action.request)).allowed, true);
  assert.equal(
    (await p.check({ ...action.request, path: "/v3/company/42/payment" })).allowed,
    false,
    "a sibling path stays closed",
  );
  assert.ok(box.calls.some((c) => c.startsWith("nemoclaw omoda policy get")));
  assert.ok(box.calls.some((c) => c.includes("openshell policy set")));
});

test("revertDelta removes the grant and re-reads to prove it", async () => {
  const box = fakeBox();
  const p = createOpenShellPolicy({ sandbox: "omoda", exec: box.exec });
  await p.applyDelta(action, { decisionId: "dec-1" });
  await p.revertDelta(action);
  assert.equal((await p.check(action.request)).allowed, false);
  assert.deepEqual(p.openDeltas, []);
});

test("a revert that did not actually take effect RAISES rather than reporting success", async () => {
  const box = fakeBox();
  const p = createOpenShellPolicy({ sandbox: "omoda", exec: box.exec });
  await p.applyDelta(action, { decisionId: "dec-1" });

  // From here the box accepts writes but silently discards them.
  const stuck = createOpenShellPolicy({
    sandbox: "omoda",
    exec: async (cmd, args, input) => {
      if (cmd === "openshell") return { code: 0, stdout: "", stderr: "" }; // pretends
      return box.exec(cmd, args, input);
    },
  });
  await stuck.applyDelta({ actionId: "act-2", request: action.request }, {});
  await assert.rejects(
    () => stuck.revertDelta({ actionId: "act-2" }),
    PolicyRevertError,
    "a silently ineffective revert is exactly how a write method survives",
  );
});

test("refuses to widen an undeclared host", async () => {
  const box = fakeBox();
  const p = createOpenShellPolicy({ sandbox: "omoda", exec: box.exec });
  await assert.rejects(
    () => p.applyDelta({ actionId: "x", request: { host: "evil.example", method: "POST", path: "/" } }, {}),
    PolicyApplyError,
  );
});

test("refuses to scope a delta on a non-rest endpoint, because it cannot be enforced", async () => {
  const box = fakeBox({ protocol: "raw" });
  const p = createOpenShellPolicy({ sandbox: "omoda", exec: box.exec });
  await assert.rejects(() => p.applyDelta(action, {}), /not protocol:rest/);
});

test("expireStale closes a capability whose window has passed", async () => {
  const box = fakeBox();
  let t = 1000;
  const p = createOpenShellPolicy({ sandbox: "omoda", exec: box.exec, ttlMs: 100, now: () => t });
  await p.applyDelta(action, {});
  assert.equal((await p.check(action.request)).allowed, true);
  t += 500;
  assert.deepEqual(await p.expireStale(), { expired: 1 });
  assert.equal((await p.check(action.request)).allowed, false, "a crashed Broker cannot leave it open");
});

test("revertAll closes everything, which is what HALT needs", async () => {
  const box = fakeBox();
  const p = createOpenShellPolicy({ sandbox: "omoda", exec: box.exec });
  await p.applyDelta({ actionId: "a", request: { host: QB, method: "POST", path: "/a" } }, {});
  await p.applyDelta({ actionId: "b", request: { host: QB, method: "PUT", path: "/b" } }, {});
  assert.deepEqual(await p.revertAll(), { reverted: 2 });
  assert.deepEqual(p.openDeltas, []);
});

test("dryRun computes the delta and never writes", async () => {
  const box = fakeBox();
  const p = createOpenShellPolicy({ sandbox: "omoda", exec: box.exec, dryRun: true });
  const r = await p.applyDelta(action, {});
  assert.equal(r.dryRun, true);
  assert.ok(!box.calls.some((c) => c.includes("openshell policy set")), "no write reached the box");
});
