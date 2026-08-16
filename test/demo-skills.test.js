import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSkills, buildCapabilityIndex } from "../src/skills/load.js";
import { prohibitedReason } from "../src/domain/prohibited.js";
import { INCIDENT_TYPES } from "../src/coco/judge.js";

const { skills, errors } = loadSkills();
const idx = buildCapabilityIndex(skills);
const byName = Object.fromEntries(skills.map((s) => [s.skill, s]));

test("all demo agents compile at their levels, hierarchy enforced", () => {
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.equal(byName["accident-agent"].level, 1);
  assert.equal(byName["fire-agent"].level, 1);
  assert.equal(byName["ambulatory"].level, 2);
  assert.equal(byName["emergency-dispatch"].level, 3);
  // L1s reason, L2/L3 do not.
  assert.equal(byName["accident-agent"].grants.inference, true);
  assert.equal(byName["ambulatory"].grants.inference, false);
  assert.equal(byName["emergency-dispatch"].grants.inference, false);
});

test("fire is a routable incident class alongside traffic-accident", () => {
  assert.ok(INCIDENT_TYPES.includes("fire"));
  assert.ok(INCIDENT_TYPES.includes("traffic-accident"));
});

test("the emergency-dispatch L3 spans the whole taxonomy in one agent", () => {
  assert.equal(idx.lookup("dispatch.status.read").consent, "none");        // read: free
  assert.equal(idx.lookup("dispatch.unit.request").consent, "approval");   // create+legal
  assert.equal(idx.lookup("dispatch.callout.cancel").consent, "two-person"); // delete+legal+reputational
});

test("roadside is the contained-write-with-undo beat: reversible, non-dangerous, autonomous", () => {
  assert.equal(idx.lookup("roadside.workorder.create").consent, "none");
  assert.equal(idx.lookup("roadside.workorder.create").verb, "create");
  assert.deepEqual(idx.lookup("roadside.workorder.create").impact, []);
});

test("ambulatory is shared: one L2 agent both L1 domains can direct", () => {
  // It exists once as a declared L2 with its own read capability. Sharing is a
  // reference, not a copy: the accident and fire agents both direct this agent.
  const amb = byName["ambulatory"];
  assert.ok(amb);
  assert.equal(amb.level, 2);
  assert.ok(amb.registry.some((r) => r.tool === "dispatch.status.read"),
    "ambulatory declares its own status read");
});

test("the prohibited beat: a city-wide broadcast has no decision path at all", () => {
  assert.equal(prohibitedReason({ tool: "dispatch.mass_broadcast" }), "no-mass-broadcast");
  assert.equal(prohibitedReason({ tool: "dispatch.city_alert" }), "no-mass-broadcast");
  // while an ordinary dispatch request is governed by consent, not prohibited
  assert.equal(prohibitedReason({ tool: "dispatch.unit.request" }), null);
});

test("every consequential dispatch write compiles to GET-only until a decision", () => {
  for (const s of skills) {
    for (const r of s.registry) {
      if (r.tool.startsWith("dispatch.") && r.consent !== "none") {
        assert.match(r.grant, /GET/, `${r.tool} should grant GET only`);
        assert.ok(!/POST|PUT|DELETE/.test(r.grant), `${r.tool} must not grant a write method pre-decision`);
      }
    }
  }
});
