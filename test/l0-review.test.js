import { test } from "node:test";
import assert from "node:assert/strict";
import { createOrchestrator, L1_BY_INCIDENT, l1FromSignals } from "../src/orchestrator.js";
import { createObservationJudge } from "../src/coco/judge.js";
import { createIntentStore } from "../src/api/intents.js";
import { createLedger } from "../src/ledger/ledger.js";
import { buildCapabilityIndex, loadSkills } from "../src/skills/load.js";
import { MODEL, ENDPOINT } from "../src/models/router.js";

const registry = buildCapabilityIndex(loadSkills().skills);
const ledger = () => createLedger({ path: `/tmp/omoda-l0-${Date.now()}-${Math.random()}.jsonl` });

let seq = 0;
const obs = (over = {}) => ({
  schema_version: "live-1", type: "observation",
  observation_id: `o-${++seq}`, camera_id: "coco-live", captured_at: "2026-08-16T04:00:00Z",
  window: { start_seconds: seq * 5, end_seconds: seq * 5 + 5, duration_seconds: 5 },
  scene_description: "Vehicles move through the intersection normally.",
  vehicles: [], pedestrians: [], objects: [], signs: [], visible_interactions: [],
  visible_actions: [], changes_from_previous: [], uncertainties: [],
  evidence_ref: { source: "coco", start_seconds: seq * 5, end_seconds: seq * 5 + 5 },
  ...over,
});

const accidentObs = () => obs({
  scene_description: "A dark sedan made contact with a light-colored vehicle; both stopped in the intersection.",
  vehicles: [{ local_track_id: "v1", motion_state: "stopped", location: "center of intersection", visible_damage: "front" }],
  visible_interactions: [{ contact_visible: true }],
  changes_from_previous: ["traffic flow changed from moving to obstructed"],
});
const fireObs = () => obs({
  scene_description: "A red car is smoking at the intersection with visible fire; a fire truck is arriving.",
  vehicles: [{ local_track_id: "v1", motion_state: "stopped", smoke_visible: true, fire_visible: true }],
});

const fakeJudge = (reply) => {
  const intents = createIntentStore();
  const inference = { calls: [], async complete(a) { this.calls.push(a); return { text: JSON.stringify(reply), model: MODEL.OMNI, endpoint: ENDPOINT.LOCAL }; } };
  const judge = createObservationJudge({ intents, ledger: ledger(), inference });
  return { judge, intents, inference };
};

test("the incident->L1 map and the deterministic signal hint agree on domains", () => {
  assert.equal(L1_BY_INCIDENT["traffic-accident"], "accident-agent");
  assert.equal(L1_BY_INCIDENT["fire"], "fire-agent");
  assert.equal(L1_BY_INCIDENT["road-maintenance"], "roadside");
  assert.equal(l1FromSignals(["interaction:contact_visible"]), "accident-agent");
  assert.equal(l1FromSignals(["vehicle:smoke_or_fire"]), "fire-agent");
  assert.equal(l1FromSignals(["sign:down"]), "roadside");
  assert.equal(l1FromSignals([]), null);
});

test("L0 reviews a nominal frame with ZERO inference and routes to no L1", async () => {
  const { judge, inference } = fakeJudge({});
  const l0 = createOrchestrator({ intents: createIntentStore(), registry, ledger: ledger(), judge });
  const r = await l0.reviewObservation(obs(), []);
  assert.equal(r.reviewed, true);
  assert.equal(r.routedToL1, null);
  assert.equal(r.inferenceUsed, false);
  assert.equal(inference.calls.length, 0, "L0's deterministic pass handled a quiet frame");
});

test("L0 reviews a collision frame and routes to the accident L1", async () => {
  const { judge, inference } = fakeJudge({ is_incident: true, incident_type: "traffic-accident", severity: "high", reason: "contact + obstruction", cleared: false });
  const l0 = createOrchestrator({ intents: createIntentStore(), registry, ledger: ledger(), judge });
  const r = await l0.reviewObservation(accidentObs(), [accidentObs()]);
  assert.equal(r.routedToL1, "accident-agent");
  assert.equal(r.inferenceUsed, true);
  assert.ok(inference.calls.length >= 1, "signals fired, so L0 used inference");
});

test("L0 reviews a fire frame and routes to the fire L1", async () => {
  const { judge } = fakeJudge({ is_incident: true, incident_type: "fire", severity: "high", reason: "visible fire and smoke", cleared: false });
  const l0 = createOrchestrator({ intents: createIntentStore(), registry, ledger: ledger(), judge });
  const r = await l0.reviewObservation(fireObs(), [fireObs()]);
  assert.equal(r.routedToL1, "fire-agent");
});

test("signals that the model judges non-incident are reviewed with inference but not routed", async () => {
  const { judge, inference } = fakeJudge({ is_incident: false, incident_type: "none", severity: "none", reason: "brief, not an incident", cleared: false });
  const l0 = createOrchestrator({ intents: createIntentStore(), registry, ledger: ledger(), judge });
  const r = await l0.reviewObservation(accidentObs(), [accidentObs()]);
  assert.equal(r.routedToL1, null);
  assert.equal(r.inferenceUsed, true, "L0 did consult the model");
  assert.ok(inference.calls.length >= 1);
});

test("with the local model down, a strong contact frame still routes to accident, deterministically", async () => {
  const intents = createIntentStore();
  const judge = createObservationJudge({ intents, ledger: ledger(), inference: { async complete() { throw new Error("should not be called"); } }, localAvailable: () => false });
  const l0 = createOrchestrator({ intents, registry, ledger: ledger(), judge, localAvailable: () => false });
  const r = await l0.reviewObservation(accidentObs(), [accidentObs()]);
  assert.equal(r.routedToL1, "accident-agent", "deterministic escalation still routes when the model is unavailable");
});

test("L0 exposes onObservation as a drop-in for the frame path", () => {
  const { judge } = fakeJudge({});
  const l0 = createOrchestrator({ intents: createIntentStore(), registry, ledger: ledger(), judge });
  assert.equal(typeof l0.onObservation, "function");
  assert.equal(l0.onObservation, l0.reviewObservation);
});
