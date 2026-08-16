import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTriggerStore, DEFAULT_TRIGGERS } from "../src/transport/triggers.js";
import { createObservationJudge } from "../src/coco/judge.js";
import { createIntentStore } from "../src/api/intents.js";
import { createLedger } from "../src/ledger/ledger.js";
import { MODEL, ENDPOINT } from "../src/models/router.js";

const tmp = (t) => { const d = mkdtempSync(join(tmpdir(), "omoda-trg-")); t.after(() => rmSync(d, { recursive: true, force: true })); return join(d, "triggers.json"); };
const ledger = () => createLedger({ path: `/tmp/omoda-trg-${Date.now()}-${Math.random()}.jsonl` });

test("a fresh store seeds the default triggers and persists them", (t) => {
  const path = tmp(t);
  const s = createTriggerStore({ path, ledger: ledger() });
  assert.equal(s.size, DEFAULT_TRIGGERS.length);
  // reload from disk: edits survive a restart
  const s2 = createTriggerStore({ path, ledger: ledger() });
  assert.equal(s2.size, DEFAULT_TRIGGERS.length);
});

test("match is deterministic substring over the text, case-insensitive", (t) => {
  const s = createTriggerStore({ path: tmp(t), ledger: ledger() });
  assert.equal(s.match("A CRASH at the intersection").rule.l1, "accident");
  assert.equal(s.match("the car is SMOKING and on fire").rule.l1, "fire");
  assert.equal(s.match("a pothole opened in the lane").rule.l1, "roadside");
  assert.equal(s.match("cars moving normally through the intersection"), null);
});

test("match is negation-aware and catches the overturned-vehicle case (from training data)", (t) => {
  const s = createTriggerStore({ path: tmp(t), ledger: ledger() });
  // negated hazards are NOT triggers: benign frames say exactly this
  assert.equal(s.match("A car drives through the intersection. There are no visible hazards."), null);
  assert.equal(s.match("No visible obstruction in the road."), null);
  assert.equal(s.match("there is no smoke"), null);
  // a real, un-negated hazard still fires
  assert.equal(s.match("smoke is pouring from the hood").rule.incidentType, "fire");
  // the overturned-truck false negative the capture surfaced is now caught
  assert.equal(s.match("a large truck is overturned, blocking lanes").rule.incidentType, "traffic-accident");
  assert.equal(s.match("the sedan is on its side").rule.incidentType, "traffic-accident");
  // "signage" was removed as a benign match; the specific sign phrases remain
  assert.equal(s.match("new signage was installed"), null);
  assert.equal(s.match("a sign is down across the lane").rule.incidentType, "fallen-signage");
});

test("admin can add and remove triggers, ledgered and persisted", (t) => {
  const path = tmp(t);
  const led = ledger();
  const s = createTriggerStore({ path, ledger: led });
  const before = s.size;
  const added = s.add({ phrases: "jackknifed, tanker leak", incidentType: "traffic-accident", l1: "accident", action: "handle the jackknife" });
  assert.equal(added.ok, true);
  assert.equal(s.match("a jackknifed semi").rule.l1, "accident");
  assert.equal(createTriggerStore({ path, ledger: led }).size, before + 1, "persisted for next boot");
  assert.equal(s.remove(added.rule.id).ok, true);
  assert.equal(s.match("a jackknifed semi"), null);
  assert.ok(led.all().some((e) => e.tool === "triggers.add"));
  assert.ok(led.all().some((e) => e.tool === "triggers.remove"));
});

test("an empty phrase list or missing L1 is refused", (t) => {
  const s = createTriggerStore({ path: tmp(t), ledger: ledger() });
  assert.equal(s.add({ phrases: "  , ", l1: "accident" }).ok, false);
  assert.equal(s.add({ phrases: "x", l1: "" }).ok, false);
});

// ── the judge flow: trigger phrase -> deterministic route, no inference ────
const obs = (over = {}) => ({
  schema_version: "live-1", type: "observation", observation_id: `o-${Math.random()}`,
  camera_id: "coco-live", captured_at: "t", window: { start_seconds: 0, end_seconds: 5 },
  scene_description: "vehicles moving normally", vehicles: [], pedestrians: [], objects: [], signs: [],
  visible_interactions: [], visible_actions: [], changes_from_previous: [], uncertainties: [],
  evidence_ref: { source: "coco", start_seconds: 0, end_seconds: 5 }, ...over,
});

function judgeWith(triggers) {
  const intents = createIntentStore();
  const inference = { calls: [], async complete() { this.calls.push(1); return { text: JSON.stringify({ is_incident: true, incident_type: "traffic-accident", severity: "high", reason: "model", cleared: false }), model: MODEL.OMNI, endpoint: ENDPOINT.LOCAL }; } };
  return { judge: createObservationJudge({ intents, ledger: ledger(), inference, triggers }), intents, inference };
}

test("a trigger phrase in the description opens an incident with NO detection inference", async (t) => {
  const triggers = createTriggerStore({ path: tmp(t), ledger: ledger() });
  const { judge, intents, inference } = judgeWith(triggers);
  const r = await judge.onObservation(obs({ scene_description: "a crash between two cars, both stopped" }), []);
  assert.equal(r.verdict, "incident");
  assert.equal(inference.calls.length, 0, "the trigger routed deterministically, model untouched");
  assert.equal(intents.all().length, 1);
  assert.equal(intents.all()[0].evidence.incident_type, "traffic-accident");
});

test("no trigger phrase but a structured signal falls through to the model", async (t) => {
  const triggers = createTriggerStore({ path: tmp(t), ledger: ledger() });
  const { judge, inference } = judgeWith(triggers);
  // contact_visible is a structured signal; the bland text matches no phrase.
  const r = await judge.onObservation(obs({ scene_description: "two objects near each other", visible_interactions: [{ contact_visible: true }] }), []);
  assert.equal(r.verdict, "incident");
  assert.equal(inference.calls.length, 1, "no trigger phrase, so the model inferred");
});

test("a runtime inference failure degrades, it does not crash the observation handler", async (t) => {
  const triggers = createTriggerStore({ path: tmp(t), ledger: ledger() });
  const intents = createIntentStore();
  // inference that always throws, as a live endpoint-unreachable would
  const inference = { async complete() { throw new Error("inference unreachable: fetch failed"); } };
  const judge = createObservationJudge({ intents, ledger: ledger(), inference, triggers });
  // a strong structured signal, no trigger phrase -> would call the model
  const strong = obs({ scene_description: "two objects near each other", visible_interactions: [{ contact_visible: true }] });
  const r1 = await judge.onObservation(strong, []);   // must not throw
  assert.equal(r1.verdict, "incident", "a strong signal still escalates in degraded mode");
  // a weak signal -> degrades to nominal, still no throw
  const weak = obs({ scene_description: "an ambulance is parked nearby" }); // 'ambulance' is a danger-lexicon signal
  const r2 = await judge.onObservation(weak, []);
  assert.ok(r2.verdict === "judged-nominal" || r2.verdict === "nominal", "a weak signal degrades to nominal, not a crash");
});

test("no trigger and no signal is ignored with zero inference", async (t) => {
  const triggers = createTriggerStore({ path: tmp(t), ledger: ledger() });
  const { judge, inference, intents } = judgeWith(triggers);
  const r = await judge.onObservation(obs({ scene_description: "cars moving normally through the intersection" }), []);
  assert.equal(r.verdict, "nominal");
  assert.equal(inference.calls.length, 0);
  assert.equal(intents.all().length, 0);
});
