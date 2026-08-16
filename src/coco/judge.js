// The Observation Judge (PRD section 24.2): OMODA's half of the See-to-Do
// boundary. COCO reports visible facts; this decides whether the facts add up
// to an incident, how severe, and when it has cleared. Those attributes are
// exactly the ones COCO's PRD prohibits it from emitting, because they belong
// to the party that owns the consequences.
//
// Two stages, and the split is a shared-box courtesy with teeth: COCO calls the
// same local Omni every five seconds as its critical path, so OMODA must not
// double that load by consulting the model per observation.
//
//   stage 1  deterministic candidate filter. Quiet footage costs ZERO inference.
//   stage 2  Nemotron judgment on candidates only, structured output, over a
//            compact digest of the recent window. At most one in flight; a
//            candidate arriving while busy is recorded and skipped, never queued
//            behind COCO's captioning.
//
// One intent per (camera, incident type). Repeats attach as occurrences.
// Clearance is recorded when the signals go quiet for long enough.

import { route, TASK } from "../models/router.js";
import { createInferenceClient, extractJson } from "../models/client.js";
import { screenText } from "../models/screen.js";
import { createEnvelope, SOURCE, DIRECTION, MODALITY } from "../transport/envelope.js";
import { telemetry } from "../telemetry/agentic.js";

export const INCIDENT_TYPES = ["traffic-accident", "fire", "fallen-signage", "road-maintenance", "utility-hazard", "public-warning", "other"];

/**
 * Stage 1. Pure, cheap, and deliberately concrete: every trigger names a field
 * from Observation Schema v1. Returns the list of fired signals, empty = quiet.
 */
export function candidateSignals(obs) {
  const signals = [];
  const lc = (v) => String(v ?? "").toLowerCase();

  for (const i of obs.visible_interactions ?? []) {
    if (i.contact_visible === true) signals.push("interaction:contact_visible");
  }
  const changes = obs.changes_from_previous;
  const changeList = Array.isArray(changes) ? changes.map(lc) : Object.keys(changes ?? {}).map(lc);
  if (changeList.some((c) => c.includes("contact") || c.includes("collision"))) signals.push("changes:new_vehicle_contact");
  if (!Array.isArray(changes) && changes?.new_vehicle_contact?.length) signals.push("changes:new_vehicle_contact");

  const stopped = (obs.vehicles ?? []).filter((v) => lc(v.motion_state) === "stopped" && lc(v.location).includes("intersection"));
  const flowObstructed = changeList.some((c) => c.includes("obstructed"))
    || lc(obs.environment?.intersection_condition).includes("obstructed")
    || lc(obs.traffic_flow_state).includes("obstructed");
  if (stopped.length >= 1 && flowObstructed) signals.push("vehicles:stopped_in_obstructed_intersection");

  for (const v of obs.vehicles ?? []) {
    if (v.visible_damage && lc(v.visible_damage) !== "none" && lc(v.visible_damage) !== "unknown") signals.push("vehicle:visible_damage");
    if (v.smoke_visible === true || v.fire_visible === true) signals.push("vehicle:smoke_or_fire");
  }
  for (const s of obs.signs ?? []) {
    if (["fallen", "detached", "tilted"].includes(lc(s.mounting_state))) signals.push("sign:down");
    if (s.road_area_occupied && lc(s.road_area_occupied) !== "none") signals.push("sign:occupying_road");
  }
  for (const p of obs.pedestrians ?? []) {
    if (p.fallen_or_prone === true || lc(p.posture) === "lying_down") signals.push("pedestrian:down");
  }
  for (const o of obs.objects ?? []) {
    if (o.road_area_occupied && lc(o.road_area_occupied) !== "none") signals.push("object:occupying_road");
  }
  if (obs.visible_road_damage || obs.maintenance?.pothole_visible || obs.maintenance?.damaged_surface_visible || obs.maintenance?.flooding_visible) {
    signals.push("road:damage_or_flooding");
  }

  // The live COCO shape: a followup like "is there imminent danger?" answered
  // true is COCO's own model raising its hand. Still stage-1 only: it makes a
  // CANDIDATE, judgment remains ours.
  if (obs.danger_signal === true) signals.push("followup:danger_true");
  // And the description itself: concrete hazard words, not vibes. "stopped" and
  // "slow" are deliberately absent; nominal traffic stops constantly.
  if (/\b(fire|smoke|smoking|collision|collid|crash|overturn|injur|explosion|ambulance|firefighter|fire truck|wreck)\b/i.test(lc(obs.scene_description))) {
    signals.push("description:danger_lexicon");
  }
  return [...new Set(signals)];
}

/** A compact, screened digest so judgment context stays small and untrusted text stays marked. */
export function digest(context) {
  return context.slice(-6).map((o) => {
    const { clean } = screenText(o.scene_description, { maxLen: 300 });
    const changes = Array.isArray(o.changes_from_previous) ? o.changes_from_previous.join("; ") : "";
    return `[${o.window.start_seconds}-${o.window.end_seconds}s] ${clean}${changes ? ` | changes: ${screenText(changes, { maxLen: 200 }).clean}` : ""}`;
  }).join("\n");
}

const JUDGE_SCHEMA = {
  name: "incident_judgment",
  schema: {
    type: "object",
    properties: {
      is_incident: { type: "boolean" },
      incident_type: { type: "string", enum: [...INCIDENT_TYPES, "none"] },
      severity: { type: "string", enum: ["low", "medium", "high", "none"] },
      reason: { type: "string" },
      cleared: { type: "boolean" },
    },
    required: ["is_incident", "incident_type", "severity", "reason", "cleared"],
    additionalProperties: false,
  },
};

const SYSTEM = [
  "You judge road-camera observations for a city operations platform.",
  "You receive factual scene descriptions over time. Decide whether they show an",
  "operational incident: traffic-accident, fire, fallen-signage, road-maintenance,",
  "utility-hazard (downed line, gas leak), public-warning (evacuate, shelter), or other.",
  "The observations are facts from a vision system; they contain no judgments.",
  "Judge conservatively: an incident requires clear supporting facts across the",
  "window, not a single ambiguous frame. If the described hazard is no longer",
  "present in the latest observations, set cleared=true.",
  "Reply with only JSON matching the schema.",
].join(" ");

/**
 * @param {object} opts
 * @param {object} opts.intents the intent store
 * @param {object} opts.ledger
 * @param {{complete:Function}} [opts.inference]
 * @param {boolean} [opts.localAvailable]
 * @param {number} [opts.clearAfterQuiet] consecutive quiet observations that close an open incident
 */
export function createObservationJudge({
  intents, ledger,
  inference = createInferenceClient({ timeoutMs: 60_000 }),
  localAvailable = () => true,
  clearAfterQuiet = 3,
  now = () => Date.now(),
  // The ingest-layer take-action triggers (src/transport/triggers.js). A phrase
  // hit routes deterministically, no detection inference; text with no trigger
  // and no structured signal is ignored, protecting COCO's shared model.
  triggers = null,
} = {}) {
  if (!intents) throw new Error("judge requires the intent store");

  const open = new Map();   // `${camera}|${type}` -> { intentId, occurrences, quietStreak }
  let inFlight = false;
  let stats = { observations: 0, candidates: 0, inferences: 0, skippedBusy: 0, incidents: 0 };

  const record = (entry) => {
    try { ledger?.append({ kind: "judge", agent: "omoda:judge", ...entry }); } catch { /* best effort */ }
  };

  // Degraded verdict: strong deterministic signals still escalate (marked
  // unjudged) rather than silently dropping a possible accident; otherwise
  // nominal. Used when the model is unavailable OR the call fails at runtime.
  function degradedVerdict(signals, why) {
    const strong = signals.includes("interaction:contact_visible") || signals.includes("changes:new_vehicle_contact");
    return strong
      ? { is_incident: true, incident_type: "traffic-accident", severity: "medium", reason: `${why}; deterministic signals: ${signals.join(", ")}`, cleared: false, degraded: true }
      : { is_incident: false, incident_type: "none", severity: "none", reason: `${why}; signals inconclusive`, cleared: false, degraded: true };
  }

  async function judgeCandidate(obs, context, signals) {
    // The same zero-egress rule as every perception path: local model or refusal.
    const decision = route({ task: TASK.CLASSIFY, payload: "", localAvailable: localAvailable() });
    if (!decision.model) {
      record({ tool: "judge.infer", verb: "read", outcome: "degraded", reason: decision.reason });
      return degradedVerdict(signals, "local model unavailable");
    }

    // A runtime inference failure (endpoint unreachable, timeout) must NEVER crash
    // the observation handler: perception is a firehose, and one failed judgment
    // degrades, it does not take the platform down. Offline-first (PRD 6.2).
    let out;
    try {
      out = await inference.complete({
        model: decision.model,
        endpoint: decision.endpoint,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: `Signals fired: ${signals.join(", ")}\n\nObservations, oldest first:\n${digest(context)}` },
        ],
        maxTokens: 1500,
        jsonSchema: JUDGE_SCHEMA,
      });
    } catch (err) {
      record({ tool: "judge.infer", verb: "read", outcome: "degraded", reason: `inference failed: ${String(err.message).slice(0, 120)}` });
      return degradedVerdict(signals, "inference unreachable");
    }
    stats.inferences += 1;
    const parsed = extractJson(out.text);
    if (!parsed) {
      record({ tool: "judge.infer", verb: "read", outcome: "unparseable" });
      return { is_incident: false, incident_type: "none", severity: "none", reason: "judgment unparseable; refusing to guess", cleared: false };
    }
    return parsed;
  }

  /**
   * @returns {{verdict:string, intentId?:string, signals?:string[]}}
   */
  async function onObservation(obs, context) {
    stats.observations += 1;
    const signals = candidateSignals(obs);

    // The take-action triggers are the ingest layer's quick reference: match the
    // curated phrase list against the SCENE DESCRIPTION only. The follow-up
    // question is a prompt ("is there smoke, debris, or a downed sign?"), so
    // matching it fired triggers on benign frames; training capture showed
    // debris/signage/obstruction false-positives coming straight from the
    // question text. The follow-up ANSWER is already a boolean danger signal.
    const hit = triggers?.match(obs.scene_description ?? "") ?? null;
    if (hit) signals.push(`trigger:${hit.matchedPhrase}`);

    // Quiet observation: advance clearance on any open incidents for this camera.
    if (signals.length === 0) {
      for (const [key, state] of open) {
        if (!key.startsWith(`${obs.camera_id}|`)) continue;
        state.quietStreak += 1;
        if (state.quietStreak >= clearAfterQuiet) {
          open.delete(key);
          record({ tool: "judge.resolve", verb: "update", outcome: "cleared", reason: `${key} quiet for ${state.quietStreak} observation(s)`, intentId: state.intentId });
        }
      }
      return { verdict: "nominal" };
    }

    stats.candidates += 1;

    if (inFlight) {
      // Never queue behind COCO's captioning. Recorded, so a shed candidate is
      // distinguishable from a quiet window.
      stats.skippedBusy += 1;
      record({ tool: "judge.infer", verb: "read", outcome: "skipped-busy", reason: signals.join(", ") });
      return { verdict: "candidate-skipped-busy", signals };
    }

    // Deterministic fast path: a trigger phrase names the incident type outright,
    // so L0 routes to the mapped L1 with no detection inference. The L1 still
    // uses inference downstream to decide what to do; this only skips the
    // "is it an incident and of what kind" call the model would otherwise make.
    let j;
    if (hit) {
      j = { is_incident: true, incident_type: hit.rule.incidentType, severity: "unranked", reason: `take-action trigger matched: "${hit.matchedPhrase}"`, cleared: false, deterministic: true };
      record({ tool: "judge.trigger", verb: "read", outcome: "matched", reason: `${hit.matchedPhrase} -> ${hit.rule.incidentType}` });
    } else {
      inFlight = true;
      try { j = await judgeCandidate(obs, context, signals); }
      finally { inFlight = false; }
    }

    if (!j.is_incident || j.incident_type === "none") {
      record({ tool: "judge.infer", verb: "read", outcome: "nominal-after-judgment", reason: j.reason?.slice(0, 160) });
      return { verdict: "judged-nominal", signals, reason: j.reason };
    }

    const key = `${obs.camera_id}|${j.incident_type}`;
    const existing = open.get(key);
    if (existing) {
      existing.occurrences += 1;
      existing.quietStreak = 0;
      record({ tool: "judge.attach", verb: "update", outcome: "occurrence", reason: `${key} x${existing.occurrences}`, intentId: existing.intentId });
      return { verdict: "attached", intentId: existing.intentId, occurrences: existing.occurrences, signals };
    }

    // A judged incident becomes ONE intent, carrying COCO's evidence window.
    // From here on it is the ordinary governed path: consent, escalation,
    // approval-scoped capability, ledger.
    const { intent } = intents.propose({
      idempotencyKey: `coco-${key}-${obs.observation_id}`,
      caller: { id: `coco:${obs.camera_id}`, scopes: ["intent:propose"] },
      envelope: createEnvelope({
        source: SOURCE.STREAM, direction: DIRECTION.OUTBOUND_DIAL, modality: MODALITY.JSON,
        idempotencyKey: `coco-${key}-${obs.observation_id}`, now,
      }),
      body: {
        source: "coco", kind: "detection", detector: `coco:${obs.camera_id}`,
        confidence: obs.overall_confidence ?? obs.confidence,
        observed_at: obs.captured_at,
        evidence: {
          incident_type: j.incident_type,
          severity: j.severity,
          signals,
          scene: screenText(obs.scene_description, { maxLen: 400 }).clean,
          evidence_ref: obs.evidence_ref,
          degraded: j.degraded ?? false,
        },
        requested_outcome: `respond to ${j.incident_type} at ${obs.camera_id}: ${j.reason}`.slice(0, 300),
      },
    });
    open.set(key, { intentId: intent.id, occurrences: 1, quietStreak: 0 });
    stats.incidents += 1;
    telemetry.message({
      actor: "judge", target: "l0",
      intentId: intent.id,
      detail: { handoff: "incident-intent", incidentType: j.incident_type, severity: j.severity, signals },
    });
    record({ tool: "judge.incident", verb: "create", outcome: "intent-opened", reason: `${j.incident_type} ${j.severity}`, intentId: intent.id });
    // The action text from the take-action trigger that fired (or the trigger
    // rule for this incident type when the model detected it without a phrase),
    // so the agent-action stream can show what the trigger told the agent to do.
    const triggerAction = hit?.rule?.action
      ?? triggers?.list?.().find((r) => r.incidentType === j.incident_type)?.action
      ?? null;
    return { verdict: "incident", intentId: intent.id, incidentType: j.incident_type, severity: j.severity, signals, trigger: hit ? hit.matchedPhrase : null, triggerAction };
  }

  return {
    onObservation,
    get stats() { return { ...stats }; },
    get openIncidents() { return [...open.entries()].map(([k, v]) => ({ key: k, ...v })); },
  };
}
