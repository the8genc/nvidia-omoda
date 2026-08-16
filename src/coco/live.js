// The LIVE COCO interface, as actually deployed on the box (distinct from the
// Observation Schema v1 in their PRD, which the adapter in adapter.js speaks):
//
//   ws://<coco>/api/local/rgb-stream   one JSON per frame {seq, index, rgb}
//   ws://<coco>/api/observability      {prompt, description, followup?}
//   GET <coco>/api/describe?prompt=..  one-off question -> {description}
//
// OMODA consumes all three into the input layer and republishes on the bus, so
// the demo app watches ONE hub instead of two platforms. Frames are relayed,
// never stored and never judged here (COCO's observability is the perception);
// descriptions are normalized into judge-consumable observations, and the
// followup danger boolean plus a hazard lexicon feed the judge's stage-1 filter.
//
// describe() is a declared read capability (skills/coco-operations): asking the
// camera a question is egress like any other, ledgered like any other.

import { z } from "zod";
import { screenText } from "../models/screen.js";

export const LiveFrame = z.object({
  seq: z.number(),
  index: z.number().optional(),
  rgb: z.string().startsWith("data:image/"),
}).passthrough();

export const LiveObservability = z.object({
  prompt: z.string().nullable().optional(),
  description: z.string().min(1),
  followup: z.object({
    question: z.string(),
    answer: z.unknown(),
  }).nullable().optional(),
}).passthrough();

/** Normalize a live observability message into what the judge consumes. */
export function toObservation(msg, { seq, now = () => Date.now(), source }) {
  const { clean, flags } = screenText(msg.description, { maxLen: 600 });
  const t = Math.floor(now() / 1000);
  return {
    schema_version: "live-1",
    type: "observation",
    observation_id: `live-${t}-${seq}`,
    camera_id: "coco-live",
    captured_at: new Date(now()).toISOString(),
    window: { start_seconds: t - 5, end_seconds: t, duration_seconds: 5 },
    scene_description: clean,
    screen_flags: flags,
    // COCO's own model answering "imminent danger?" with true. Stage-1 input.
    danger_signal: msg.followup?.answer === true,
    followup_question: msg.followup?.question ?? null,
    prompt: msg.prompt ?? null,
    vehicles: [], pedestrians: [], objects: [], signs: [],
    visible_interactions: [], visible_actions: [], changes_from_previous: [],
    uncertainties: [],
    evidence_ref: { source, start_seconds: t - 5, end_seconds: t },
  };
}

export function createCocoLive({
  base,                       // http://100.71.143.26:8091
  judge, bus, ledger,
  WebSocketImpl, fetchImpl = globalThis.fetch,
  reconnectMs = 5000, maxReconnectMs = 60_000,
  contextSize = 6,
  onLog = () => {},
  now = () => Date.now(),
} = {}) {
  if (!base) throw new Error("coco live requires the base url");
  if (!judge || !bus) throw new Error("coco live requires the judge and the bus");
  const wsBase = base.replace(/^http/, "ws");
  const context = [];
  let obsSeq = 0;
  let running = false;
  const sockets = [];

  const record = (entry) => {
    try { ledger?.append({ kind: "coco-live", verb: "read", ...entry }); } catch { /* best effort */ }
  };

  /** One frame in, one frame out. Relayed verbatim plus sequence metadata. */
  function handleFrame(raw) {
    let frame;
    try { frame = LiveFrame.parse(JSON.parse(String(raw))); }
    catch { return { kind: "rejected", reason: "malformed frame" }; }
    bus.publish("frame", { seq: frame.seq, index: frame.index ?? null, rgb: frame.rgb });
    return { kind: "frame", seq: frame.seq };
  }

  /** One description in: normalize, judge, publish description PLUS verdict. */
  async function handleObservability(raw) {
    let msg;
    try { msg = LiveObservability.parse(JSON.parse(String(raw))); }
    catch (err) {
      record({ tool: "coco.observability", outcome: "rejected", reason: String(err.message).slice(0, 120) });
      return { kind: "rejected", reason: "malformed observability message" };
    }
    const obs = toObservation(msg, { seq: ++obsSeq, now, source: `${wsBase}/api/observability` });
    context.push(obs);
    if (context.length > contextSize) context.shift();

    const verdict = await judge.onObservation(obs, [...context]);
    bus.publish("observation", {
      source: "coco-live",
      description: obs.scene_description,
      prompt: obs.prompt,
      followup: msg.followup ?? null,
      danger_signal: obs.danger_signal,
      ...verdict,
    });
    return { kind: "observation", ...verdict };
  }

  /**
   * The one-off question. A declared read capability: asking a camera a
   * question is egress, and it is ledgered whether it succeeds or not.
   */
  async function describe(prompt) {
    const url = `${base}/api/describe?prompt=${encodeURIComponent(prompt)}`;
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const { clean } = screenText(body.description ?? "", { maxLen: 600 });
      record({ tool: "coco.describe", outcome: "answered", reason: prompt.slice(0, 120) });
      return { description: clean };
    } catch (err) {
      record({ tool: "coco.describe", outcome: "failed", reason: err.message.slice(0, 120) });
      throw err;
    }
  }

  function dial(path, onMessage) {
    let ws = null, backoff = reconnectMs, timer = null;
    const connect = () => {
      ws = new WebSocketImpl(`${wsBase}${path}`);
      ws.on("open", () => { backoff = reconnectMs; onLog(`coco ${path} connected`); });
      ws.on("message", (d) => onMessage(typeof d === "string" ? d : d.toString("utf8")));
      ws.on("error", () => { /* surfaced through close */ });
      ws.on("close", () => {
        if (!running) return;
        onLog(`coco ${path} closed; redialing in ${Math.round(backoff / 1000)}s`);
        timer = setTimeout(() => { if (running) connect(); }, backoff);
        backoff = Math.min(backoff * 2, maxReconnectMs);
      });
    };
    return {
      start: connect,
      stop() { clearTimeout(timer); try { ws?.close(); } catch { /* gone */ } },
    };
  }

  return {
    handleFrame, handleObservability, describe, toObservation,
    start() {
      running = true;
      const f = dial("/api/local/rgb-stream", handleFrame);
      const o = dial("/api/observability", (raw) => { void handleObservability(raw); });
      sockets.push(f, o);
      f.start(); o.start();
    },
    stop() { running = false; for (const s of sockets) s.stop(); },
    get running() { return running; },
  };
}
