// Durable, in-product training capture.
//
// The ad-hoc box script that started this was throwaway; this is the feature that
// makes it last. It subscribes to the observation bus and appends one labeled
// JSONL row per frame description, so the team can keep gathering training data
// from the live stream by pressing a button in the admin dashboard.
//
// Labels match the ad-hoc capture and the platform's own judgment:
//   action      L0 would route this to an L1 (an incident, or a trigger word hit)
//   borderline  signals fired but it was judged not an incident (tuning candidate)
//   normal      quiet, nothing fired
//
// It never throws into the bus: a recorder fault must not disturb the platform.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export function createTrainingRecorder({ bus, triggers = null, dir = "var/training", now = () => new Date() } = {}) {
  let active = false;
  let unsub = null;
  let file = null;
  let startedAt = null;
  const tally = { action: 0, borderline: 0, normal: 0, total: 0 };

  function label(ev) {
    const text = ev.description ?? ev.scene_description ?? "";
    const hit = triggers?.match?.(text) ?? null;
    const v = ev.verdict;
    const incidentType = ev.incidentType ?? hit?.rule?.incidentType ?? null;
    let lab;
    if (v === "incident" || v === "attached" || hit) lab = "action";
    else if (v === "judged-nominal" || (ev.signals && ev.signals.length) || ev.danger_signal === true) lab = "borderline";
    else lab = "normal";
    return {
      label: lab, incidentType,
      triggerPhrase: hit?.matchedPhrase ?? null,
      l1: hit?.rule?.l1 ?? null,
      signals: ev.signals ?? [], verdict: v ?? null, text,
    };
  }

  function onObservation(ev) {
    try {
      const L = label(ev);
      appendFileSync(file, JSON.stringify({ at: now().toISOString(), ...L }) + "\n");
      tally[L.label] += 1;
      tally.total += 1;
    } catch { /* never break the bus */ }
  }

  return {
    /** Begin appending to a fresh file. Idempotent while already recording. */
    start() {
      if (active) return { ok: true, already: true, file };
      mkdirSync(dir, { recursive: true });
      const stamp = now().toISOString().replace(/[:.]/g, "-");
      file = join(dir, `training-live-${stamp}.jsonl`);
      startedAt = now().toISOString();
      unsub = bus.subscribe("observation", onObservation);
      active = true;
      return { ok: true, file };
    },
    /** Stop and return the file plus the tally gathered this session. */
    stop() {
      if (!active) return { ok: true, already: true };
      unsub?.();
      unsub = null;
      active = false;
      return { ok: true, file, tally: { ...tally } };
    },
    status() {
      return { active, file, startedAt, tally: { ...tally } };
    },
    _label: label, // exposed for tests
  };
}
