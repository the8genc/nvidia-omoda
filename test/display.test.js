import { test } from "node:test";
import assert from "node:assert/strict";
import { toAgentDisplay, levelFor, skillLevelMap } from "../src/telemetry/display.js";
import { loadSkills } from "../src/skills/load.js";

const levels = skillLevelMap(loadSkills().skills);

test("levelFor uses the manifest agent name, humans, and inputs", () => {
  // Manifest agent names (the `agent:` field), not skill names.
  assert.equal(levelFor("accident", levels), 1);
  assert.equal(levelFor("ambulatory", levels), 2);
  assert.equal(levelFor("emergency-dispatch", levels), 3);
  assert.equal(levelFor("l0", levels), 0);
  assert.equal(levelFor("operator:arif", levels), "operator");
  assert.equal(levelFor("coco:coco-live", levels), "input");
  assert.equal(levelFor("something-unknown", levels), null);
});

test("toAgentDisplay keeps only the four display fields plus seq and tier", () => {
  const entry = {
    seq: 42, agent: "finance", tool: "quickbooks.invoice.create", verb: "create",
    impact: ["financial"], tier: "consequential", outcome: "executed",
    authority: "decision:dec_secret", reason: "raise the incident callout invoice",
    hash: "abc123", prevHash: "def456",
  };
  const d = toAgentDisplay(entry, levels);
  assert.deepEqual(Object.keys(d).sort(), ["action", "instruction", "level", "name", "outcome", "seq", "tier"]);
  assert.equal(d.name, "finance");
  assert.equal(d.level, 2);
  assert.equal(d.action, "create quickbooks.invoice.create");
  assert.equal(d.instruction, "raise the incident callout invoice");
  assert.equal(d.tier, "consequential");
  // the bulky, sensitive fields never reach the wire
  assert.equal(d.authority, undefined);
  assert.equal(d.hash, undefined);
});
