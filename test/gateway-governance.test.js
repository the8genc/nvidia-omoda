import { test } from "node:test";
import assert from "node:assert/strict";
import { prohibitedReason } from "../src/domain/prohibited.js";
import { loadSkills, buildCapabilityIndex } from "../src/skills/load.js";
import { consentKind, VERB, IMPACT } from "../src/domain/taxonomy.js";
import { authorize } from "../src/broker/authorize.js";
import { createLedger } from "../src/ledger/ledger.js";

const registry = buildCapabilityIndex(loadSkills().skills);

// ── the gateway's control plane has no approval path ──────────────────────
const CONTROL_PLANE = [
  "openclaw.exec.approvals.set",
  "openclaw.exec.approvals.node.set",
  "openclaw.config.set",
  "openclaw.config.apply",
  "openclaw.config.patch",
  "openclaw.device.token.rotate",
  "openclaw.device.token.revoke",
  "openclaw.device.pair.approve",
  "openclaw.node.pair.approve",
];

for (const tool of CONTROL_PLANE) {
  test(`${tool} is prohibited, so no decision can unlock it`, () => {
    assert.equal(prohibitedReason({ tool }), "gateway-self-protection");
  });
}

test("an ordinary gateway write is NOT prohibited; it is merely consequential", () => {
  // The distinction that matters: dangerous needs consent, self-referential
  // needs refusal. Blanket-prohibiting the gateway would make it unusable.
  for (const tool of ["openclaw.agents.create", "openclaw.cron.add", "openclaw.agents.delete"]) {
    assert.equal(prohibitedReason({ tool }), null, tool);
  }
});

test("a lookalike outside the openclaw namespace does not trip the rule", () => {
  assert.equal(prohibitedReason({ tool: "myapp.config.set" }), null);
  assert.equal(prohibitedReason({ tool: "config.set" }), null);
});

test("the Broker refuses a control-plane call even holding a VALID decision", async () => {
  const ledger = createLedger({ path: `/tmp/omoda-gw-${process.pid}-${Math.random()}.jsonl` });
  let ran = false;
  const action = {
    actionId: "a1", agent: "operator", tool: "openclaw.config.set",
    verb: VERB.UPDATE, impact: [IMPACT.LEGAL], declared: false,
    request: { host: "host.openshell.internal", method: "POST", path: "/rpc" },
  };
  const decision = {
    decisionId: "d1", actionId: "a1", verdict: "approve", reason: "operator approved it",
    decidedBy: "operator:arif", proposedBy: "paperclip:orchestrator",
    scopes: ["intent:decide"], spent: false, settled: true, expiresAt: Date.now() + 60_000,
  };
  const out = await authorize(action, {
    ledger, decision, execute: async () => { ran = true; return {}; },
  }).catch((err) => ({ refused: true, message: err.message }));

  assert.equal(ran, false, "the execute callback must never run");
  const text = out.refused ? out.message : `${out.status} ${out.reason ?? ""}`;
  assert.match(text, /prohibited|gateway-self-protection/);
  assert.ok(
    ledger.all().some((e) => e.outcome === "refused" || e.tier === "prohibited"),
    "the refusal is on the record",
  );
});

// ── the gateway surface is governed by the same taxonomy as everything ────
test("gateway reads are unattended, writes are gated, deletes escalate further", () => {
  const cases = [
    ["openclaw.agents.list", "none"],
    ["openclaw.cron.list", "none"],
    ["openclaw.sessions.list", "none"],
    ["openclaw.cron.add", "review"],
    ["openclaw.agents.create", "review"],
  ];
  for (const [tool, expected] of cases) {
    const row = registry.lookup(tool);
    assert.ok(row, `${tool} should be declared`);
    assert.equal(row.consent, expected, tool);
  }
});

test("deleting a live agent runtime requires two people", () => {
  const row = registry.lookup("openclaw.agents.delete");
  assert.ok(row);
  assert.equal(row.verb, VERB.DELETE);
  assert.deepEqual([...row.impact].sort(), ["legal", "reputational"]);
  assert.equal(row.consent, "two-person");
  assert.equal(consentKind(row.verb, row.impact), "two-person");
});

test("every declared gateway write compiles to GET only until a decision exists", async () => {
  const { mergeFragments } = await import("../src/skills/load.js");
  const { createSimulatedPolicy } = await import("../src/policy/envelope.js");
  const policy = createSimulatedPolicy(mergeFragments(loadSkills().skills));
  const check = policy.check({ host: "host.openshell.internal", method: "POST", path: "/rpc" });
  assert.equal(check.status, 403, "POST to the gateway is absent from the compiled envelope");
  assert.match(check.reason, /not granted|absent/);
});

test("a gateway method absent from every manifest is undeclared, not merely ungated", () => {
  assert.equal(registry.isDeclared("openclaw.talk.session.create"), false);
  assert.equal(registry.isDeclared("openclaw.skills.upload.begin"), false);
  assert.equal(registry.isDeclared("openclaw.agents.list"), true);
});
