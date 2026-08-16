// The COCO leg of the See-to-Do merge (PRD section 24).
//
// COCO hosts ws://<see-host>:<port>/observations and publishes Observation
// Schema v1. This adapter is OMODA's side of that contract: it validates the
// three message types, keeps a rolling temporal context per camera, and hands
// observations to the judge. Status and error frames are operational telemetry:
// ledgered, never intents.
//
// The boundary matters more than the plumbing. COCO emits visible facts and is
// prohibited from emitting is_anomaly, severity, intent, or recommendations.
// Everything judgment-shaped happens on THIS side, by the party that owns the
// consequences. An observation is not a request for work; it becomes one only
// when the judge says the facts add up to an incident.

import { z } from "zod";

// Lenient on optional detail, strict on what we actually consume. COCO's
// attribute catalog is large and explicitly allows unknown/null everywhere, so
// passthrough() keeps unmodeled fields rather than rejecting honest data.
const Window = z.object({
  start_seconds: z.number(),
  end_seconds: z.number(),
  duration_seconds: z.number().optional(),
}).passthrough();

export const Observation = z.object({
  schema_version: z.string(),
  type: z.literal("observation"),
  observation_id: z.string().min(1),
  camera_id: z.string().min(1),
  captured_at: z.string().min(1),
  window: Window,
  scene_description: z.string().min(1),
  traffic_signals: z.array(z.object({}).passthrough()).default([]),
  vehicles: z.array(z.object({}).passthrough()).default([]),
  pedestrians: z.array(z.object({}).passthrough()).default([]),
  objects: z.array(z.object({}).passthrough()).default([]),
  signs: z.array(z.object({}).passthrough()).default([]),
  visible_interactions: z.array(z.object({}).passthrough()).default([]),
  visible_actions: z.array(z.string()).default([]),
  changes_from_previous: z.union([z.array(z.string()), z.object({}).passthrough()]).default([]),
  confidence: z.number().min(0).max(1).optional(),
  overall_confidence: z.number().min(0).max(1).optional(),
  uncertainties: z.array(z.string()).default([]),
  evidence_ref: z.object({
    source: z.string().min(1),
    start_seconds: z.number(),
    end_seconds: z.number(),
  }).passthrough(),
  processing_latency_ms: z.number().optional(),
}).passthrough();

export const StreamStatus = z.object({
  schema_version: z.string(),
  type: z.literal("stream_status"),
  camera_id: z.string(),
  status: z.enum(["available", "unavailable", "ended"]),
  timestamp: z.string(),
  detail: z.string().optional(),
}).passthrough();

export const ObservationError = z.object({
  schema_version: z.string(),
  type: z.literal("observation_error"),
  camera_id: z.string(),
  window: Window.optional(),
  error_code: z.string(),
  retryable: z.boolean().optional(),
  timestamp: z.string(),
}).passthrough();

/**
 * @param {object} opts
 * @param {{onObservation:Function}} opts.judge
 * @param {object} opts.ledger
 * @param {number} [opts.contextSize] rolling observations kept per camera
 */
export function createCocoAdapter({ judge, ledger, contextSize = 6 } = {}) {
  if (!judge) throw new Error("coco adapter requires the observation judge");
  const contexts = new Map(); // camera_id -> recent observations, oldest first

  const record = (entry) => {
    try { ledger?.append({ kind: "coco", verb: "read", ...entry }); }
    catch { /* telemetry is best effort; observations that matter are ledgered downstream */ }
  };

  function contextFor(cameraId) {
    if (!contexts.has(cameraId)) contexts.set(cameraId, []);
    return contexts.get(cameraId);
  }

  /**
   * One frame off the socket. Returns what happened, always.
   * @returns {{kind:string, ...}}
   */
  async function handleMessage(raw) {
    let frame;
    try { frame = typeof raw === "string" ? JSON.parse(raw) : raw; }
    catch { return { kind: "rejected", reason: "frame is not JSON" }; }

    const type = frame?.type;

    if (type === "stream_status") {
      const parsed = StreamStatus.safeParse(frame);
      if (!parsed.success) return { kind: "rejected", reason: "malformed stream_status" };
      record({ tool: "coco.stream_status", outcome: parsed.data.status, reason: parsed.data.detail ?? "", camera: parsed.data.camera_id });
      return { kind: "status", status: parsed.data.status, cameraId: parsed.data.camera_id };
    }

    if (type === "observation_error") {
      const parsed = ObservationError.safeParse(frame);
      if (!parsed.success) return { kind: "rejected", reason: "malformed observation_error" };
      // Their FR-7: a failed inference must never fabricate an observation.
      // Ours: a reported failure must never fabricate an incident. Ledger and move on.
      record({ tool: "coco.observation_error", outcome: "recorded", reason: parsed.data.error_code, camera: parsed.data.camera_id });
      return { kind: "error", errorCode: parsed.data.error_code, cameraId: parsed.data.camera_id };
    }

    if (type === "observation") {
      const parsed = Observation.safeParse(frame);
      if (!parsed.success) {
        record({ tool: "coco.observation", outcome: "rejected", reason: parsed.error.issues[0]?.message?.slice(0, 120) });
        return { kind: "rejected", reason: `schema: ${parsed.error.issues[0]?.message ?? "invalid"}` };
      }
      const obs = parsed.data;
      const ctx = contextFor(obs.camera_id);
      ctx.push(obs);
      if (ctx.length > contextSize) ctx.shift();
      // Judgment is OMODA's job, and it reasons over the window, not the frame.
      const verdict = await judge.onObservation(obs, [...ctx]);
      return { kind: "observation", observationId: obs.observation_id, cameraId: obs.camera_id, ...verdict };
    }

    return { kind: "rejected", reason: `unknown message type "${String(type).slice(0, 40)}"` };
  }

  return {
    handleMessage,
    contextFor: (cameraId) => [...contextFor(cameraId)],
  };
}
