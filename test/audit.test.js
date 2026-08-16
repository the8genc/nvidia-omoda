import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAuditWorthy, ledgerToAudit, handoffToAudit } from "../src/telemetry/audit.js";
import { createBus } from "../src/bus.js";
import { createLedger } from "../src/ledger/ledger.js";
import { createOrchestrator } from "../src/orchestrator.js";
import { createObservationJudge } from "../src/coco/judge.js";
import { createTriggerStore } from "../src/transport/triggers.js";
import { createIntentStore } from "../src/api/intents.js";
import { buildCapabilityIndex, loadSkills } from "../src/skills/load.js";
import { skillLevelMap } from "../src/telemetry/display.js";
import { narrateEntry } from "../src/telemetry/narrate.js";
import { outputTopicFor } from "../src/api/outputs.js";
import { MODEL, ENDPOINT } from "../src/models/router.js";

const skills = loadSkills().skills;
const registry = buildCapabilityIndex(skills);
const levels = skillLevelMap(skills);
const tmp = () => join(mkdtempSync(join(tmpdir(), "omoda-audit-")), "l.jsonl");

test("the audit endpoint is its own bus topic", () => {
  assert.equal(outputTopicFor("/v1/out/audit"), "audit");
});

test("ledgerToAudit produces the eight demo fields from a consented action", () => {
  const e = ledgerToAudit({
    at: "2026-08-16T04:00:00.000Z", agent: "emergency-dispatch", tool: "dispatch.unit.request",
    verb: "create", impact: ["legal"], tier: "consequential", authority: "decision:d-42",
    decidedBy: "arif", outcome: "executed", reason: "respond to traffic-accident", intentId: "int-9",
    seq: 12, hash: "abc123",
  }, levels);
  assert.equal(e.time, "2026-08-16T04:00:00.000Z");        // 1 time
  assert.equal(e.agent.name, "emergency-dispatch");         // 2 agent name
  assert.match(e.agent.display, /emergency dispatch/);
  assert.equal(e.tool, "dispatch.unit.request");            // 3 tool used
  assert.equal(e.trigger.verb, "create");                   // 4 trigger word: verb
  assert.equal(e.trigger.noun, "unit");                     //   ... and noun (from the tool)
  assert.equal(e.tier.label, "L3");                         // 5 agent tier
  assert.equal(e.authority.kind, "operator");               // 6 authority: a person
  assert.equal(e.authority.who, "arif");
  assert.equal(e.outcome, "executed");                      // 7 outcome
  assert.equal(e.intent.id, "int-9");                       // 8 intent: why
  assert.match(e.intent.why, /traffic-accident/);
  assert.equal(e.seq, 12);                                  // provenance: it is a durable row
  assert.equal(e.hash, "abc123");
  assert.equal(e.source, "ledger");
});

test("an autonomous read is authorised by the envelope, not a person", () => {
  const e = ledgerToAudit({ at: "t", agent: "roadside", tool: "roadside.segment.read", verb: "read", tier: "safe", authority: "envelope", outcome: "executed" }, levels);
  assert.equal(e.authority.kind, "envelope");
  assert.equal(e.authority.who, null);
});

test("a consequential write awaiting approval reads as pending, not admitted", () => {
  const e = ledgerToAudit({ agent: "procurement-gateway", tool: "procurement.callout.authorize", verb: "create", impact: ["financial"], tier: "consequential", authority: "pending", outcome: "admitted", intentId: "i" }, levels);
  assert.equal(e.authority.kind, "pending");
  assert.equal(e.outcome, "awaiting-approval");
});

test("isAuditWorthy keeps the triggered chain and drops the watching", () => {
  // dropped: perception, knowledge, admin, and the judge's own verdict rows
  assert.equal(isAuditWorthy({ kind: "coco", tool: "coco.describe" }), false);
  assert.equal(isAuditWorthy({ kind: "coco-live", tool: "coco.frames.read" }), false);
  assert.equal(isAuditWorthy({ kind: "knowledge", tool: "knowledge.retrieve" }), false);
  assert.equal(isAuditWorthy({ kind: "triggers", tool: "triggers.add" }), false);
  assert.equal(isAuditWorthy({ kind: "judge", tool: "judge.trigger" }), false);
  // dropped: the broker's duplicate pre-execution row for an auto-run tier
  assert.equal(isAuditWorthy({ tier: "safe", outcome: "admitted" }), false);
  assert.equal(isAuditWorthy({ tier: "contained", outcome: "admitted" }), false);
  // kept: the L0 trigger, broker terminal rows, the consequential escalation, undo
  assert.equal(isAuditWorthy({ kind: "orchestrator", agent: "l0", tool: "l0.review", outcome: "routed-to-l1" }), true);
  assert.equal(isAuditWorthy({ tier: "consequential", outcome: "admitted", authority: "pending" }), true);
  assert.equal(isAuditWorthy({ tier: "safe", outcome: "executed" }), true);
  assert.equal(isAuditWorthy({ kind: "undo", outcome: "undone" }), true);
});

test("handoffToAudit turns an L1->L3 handoff into the agent-to-agent flow", () => {
  const ev = { agent: { name: "accident", level: 1, role: "domain expert" }, relies_on: [{ name: "ambulatory", level: 2 }], doing: "request an ambulance", dangerous: true, intentId: "int-1", headline: "..." };
  const e = handoffToAudit(ev, levels);
  assert.equal(e.agent.name, "accident");
  assert.equal(e.tier.label, "L1");
  assert.equal(e.trigger.verb, "delegate");
  assert.equal(e.trigger.noun, "ambulatory");
  assert.equal(e.relies_on.tier.label, "L2");
  assert.equal(e.outcome, "awaiting-approval");   // the hop is dangerous
  assert.equal(e.intent.id, "int-1");
  assert.equal(e.source, "engagement");
});

// End to end: the audit stream begins at the L0 trigger and captures the chain,
// and a quiet frame produces nothing at all.
function harness() {
  const bus = createBus();
  const audit = [];
  bus.subscribe("audit", (e) => audit.push(e));
  const ledger = createLedger({
    path: tmp(),
    onAppend: (rec) => { bus.publish("agent", narrateEntry(rec, levels)); if (isAuditWorthy(rec)) bus.publish("audit", ledgerToAudit(rec, levels)); },
  });
  const intents = createIntentStore();
  const inference = { async complete() { return { text: "{}", model: MODEL.OMNI, endpoint: ENDPOINT.LOCAL }; } };
  const triggers = createTriggerStore({ path: tmp(), ledger });
  const judge = createObservationJudge({ intents, ledger, inference, triggers });
  const l0 = createOrchestrator({ intents, registry, ledger, judge, bus, levelMap: levels });
  return { bus, audit, l0 };
}

const obs = (scene) => ({
  schema_version: "live-1", type: "observation", observation_id: `o-${Math.random()}`,
  camera_id: "coco-live", captured_at: "2026-08-16T04:00:00Z",
  window: { start_seconds: 0, end_seconds: 5, duration_seconds: 5 },
  scene_description: scene, vehicles: [], pedestrians: [], objects: [], signs: [],
  visible_interactions: [], visible_actions: [], changes_from_previous: [], uncertainties: [],
  evidence_ref: { source: "coco", start_seconds: 0, end_seconds: 5 },
});

test("a quiet frame produces no audit records at all", async () => {
  const { audit, l0 } = harness();
  await l0.reviewObservation(obs("Vehicles move through the intersection normally."), []);
  assert.equal(audit.length, 0, "watching is not the audit trail");
});

test("a triggered frame opens the trail with the trigger word and captures the L1->L3 chain", async () => {
  const { audit, l0 } = harness();
  await l0.reviewObservation(obs("A multi-car collision blocks the intersection."), []);
  assert.ok(audit.length > 0, "the trigger opens the trail");

  // the origin row: L0, carrying the trigger word and the incident it opened
  const origin = audit.find((e) => e.tier.label === "L0");
  assert.ok(origin, "the L0 trigger event is present");
  assert.equal(origin.trigger.phrase, "collision", "the take-action word is captured");
  assert.ok(origin.intent.id, "the origin carries the incident id");

  // the downstream engagement: L1 hands to an L2/L3, all under the same incident
  const handoffs = audit.filter((e) => e.source === "engagement");
  assert.ok(handoffs.length >= 2, "the L1->L2->L3 chain is captured");
  assert.ok(handoffs.every((e) => e.intent.id === origin.intent.id), "every hop belongs to the same incident");
  assert.ok(handoffs.some((e) => e.tier.label === "L1"));
  assert.ok(handoffs.some((e) => e.outcome === "awaiting-approval"), "a dangerous hop shows it is held for approval");
});
