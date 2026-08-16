import { test } from "node:test";
import assert from "node:assert/strict";
import { describeAgent, narrateHandoff, narrateEntry, narrateResponse } from "../src/telemetry/narrate.js";
import { skillLevelMap, levelFor } from "../src/telemetry/display.js";
import { loadSkills } from "../src/skills/load.js";

const levels = skillLevelMap(loadSkills().skills);

test("describeAgent gives clean phrases for each level and the specials", () => {
  assert.equal(describeAgent("l0", levels).phrase, "OMODA");
  assert.equal(describeAgent("accident", levels).phrase, "the accident domain expert (L1)");
  assert.equal(describeAgent("ambulatory", levels).phrase, "the ambulatory worker (L2)");
  assert.equal(describeAgent("emergency-dispatch", levels).phrase, "the emergency dispatch tool specialist (L3)");
  assert.equal(describeAgent("operator:arif", levels).phrase, "the operator");
  assert.equal(describeAgent("coco:coco-live", levels).phrase, "the coco live feed");
});

test("a handoff reads as a sentence and names who it relies on", () => {
  const e = narrateHandoff({ from: "accident", to: "ambulatory", doing: "assess whether anyone needs EMS" }, levels);
  assert.equal(e.kind, "handoff");
  assert.match(e.headline, /accident domain expert \(L1\) handed off to the ambulatory worker \(L2\) to assess/);
  assert.deepEqual(e.relies_on, [{ name: "ambulatory", level: 2, role: "worker" }]);
});

test("a dangerous handoff says it is held for human approval", () => {
  const e = narrateHandoff({ from: "ambulatory", to: "emergency-dispatch", doing: "request an ambulance", dangerous: true }, levels);
  assert.match(e.headline, /dangerous action, so it is held for human approval/);
  assert.equal(e.dangerous, true);
});

test("narrateResponse walks the whole org chart for an incident, L0 down to the L3 calls", () => {
  const flow = narrateResponse({ incidentType: "traffic-accident", l1: "accident", intentId: "int_1" }, levels);
  const headlines = flow.map((e) => e.headline).join("\n");
  assert.match(headlines, /^OMODA handed off to the accident domain expert \(L1\)/m);
  assert.match(headlines, /accident domain expert \(L1\) handed off to the ambulatory worker \(L2\)/);
  assert.match(headlines, /ambulatory worker \(L2\) handed off to the emergency dispatch tool specialist \(L3\).*human approval/s);
  assert.ok(flow.every((e) => e.intentId === "int_1"), "every hop carries the incident it belongs to");
  // the accident chain escalates the two 911 calls plus the crane spend and the
  // evidence export, four governed hops in all
  assert.equal(flow.filter((e) => e.dangerous).length, 4, "the 911 calls, the crane callout, and the evidence export are all held");
  assert.match(headlines, /handed off to the procurement worker \(L2\) to line up a crane/);
  assert.match(headlines, /export the collision footage as evidence.*human approval/s);
});

test("the fire flow routes through the fire department and shared ambulatory", () => {
  const flow = narrateResponse({ incidentType: "fire", l1: "fire", intentId: "i" }, levels);
  const h = flow.map((e) => e.headline).join("\n");
  assert.match(h, /fire domain expert \(L1\) handed off to the fire department worker \(L2\)/);
  assert.match(h, /handed off to the ambulatory worker \(L2\)/);
});

test("narrateEntry turns broker outcomes into human sentences", () => {
  const esc = narrateEntry({ agent: "emergency-dispatch", tool: "dispatch.unit.request", verb: "create", outcome: "escalated", tier: "consequential" }, levels);
  assert.match(esc.headline, /needs human approval before it can dispatch.unit.request/);
  const done = narrateEntry({ agent: "emergency-dispatch", tool: "dispatch.unit.request", outcome: "executed" }, levels);
  assert.match(done.headline, /completed dispatch.unit.request/);
  const prohibited = narrateEntry({ agent: "operator", tool: "dispatch.mass_broadcast", outcome: "refused", reason: "prohibited: no-mass-broadcast", tier: "prohibited" }, levels);
  assert.match(prohibited.headline, /prohibited, and was blocked/);
  const approve = narrateEntry({ agent: "operator:arif", tool: "telegram.decide", reason: "approve" }, levels);
  assert.match(approve.headline, /operator approved/);
});

test("the event keeps structured fields alongside the headline for the UI", () => {
  const e = narrateEntry({ seq: 9, agent: "roadside", tool: "roadside.workorder.create", verb: "create", outcome: "executed", reason: "open a tow request" }, levels);
  assert.equal(e.agent.name, "roadside");
  assert.equal(e.agent.level, 2);
  assert.equal(e.action, "create roadside.workorder.create");
  assert.equal(e.instruction, "open a tow request");
  assert.equal(e.seq, 9);
  assert.ok(e.headline.length > 0);
});
