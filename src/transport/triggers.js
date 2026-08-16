// The "take-action triggers": the ingest layer's quick-reference lookup.
//
// L0 checks every observation's text (description, question, answer) against
// this list FIRST, deterministically and cheaply. A phrase hit routes straight
// to the mapped L1 domain agent without an inference call. Only text that
// matches no trigger falls through to the model to infer what, if anything, to
// do from the known agent skills. Text that raises nothing is ignored.
//
// It is editable from the admin portal: the operator curates the phrases and the
// L1 each maps to. Persisted so edits survive a restart; every edit is ledgered.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

// Seeded from the incident vocabulary we shipped. Each rule maps a set of
// phrases to the incident type and the L1 that owns the response.
export const DEFAULT_TRIGGERS = [
  { phrases: ["crash", "collision", "collided", "vehicles made contact", "wreck", "rear-ended", "T-boned", "hit and run"], incidentType: "traffic-accident", l1: "accident", action: "coordinate the accident response (EMS, police)" },
  { phrases: ["fire", "smoke", "smoking", "flames", "ablaze", "explosion", "burning"], incidentType: "fire", l1: "fire", action: "coordinate the fire response (fire department, EMS)" },
  { phrases: ["injured", "injury", "person down", "pedestrian struck", "someone is hurt", "unconscious", "lying in the road"], incidentType: "traffic-accident", l1: "accident", action: "escalate for EMS via the accident agent" },
  { phrases: ["fallen sign", "sign is down", "signage", "debris", "obstruction", "blocked lane", "object in the road", "tree branch"], incidentType: "fallen-signage", l1: "roadside", action: "open a roadside work order to clear the obstruction" },
  { phrases: ["pothole", "road damage", "flooding", "standing water", "sinkhole", "damaged surface", "washed out"], incidentType: "road-maintenance", l1: "roadside", action: "open a Seattle DOT maintenance work order" },
];

const normalize = (s) => String(s ?? "").toLowerCase();

export function createTriggerStore({ path = "var/triggers.json", ledger = null, seed = DEFAULT_TRIGGERS } = {}) {
  let rules = [];

  function persist() {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, rules }, null, 2));
  }

  if (existsSync(path)) {
    try { rules = JSON.parse(readFileSync(path, "utf8")).rules ?? []; }
    catch { rules = []; }
  }
  if (rules.length === 0) {
    rules = seed.map((r) => ({ id: `trg_${randomUUID().slice(0, 8)}`, ...r }));
    persist();
  }

  const record = (entry) => {
    try { ledger?.append({ kind: "triggers", agent: "admin", verb: "update", ...entry }); }
    catch { /* best effort */ }
  };

  /**
   * Deterministic match over free text. Returns the first rule whose phrase
   * appears, with the phrase that hit, or null. Cheap: substring over a
   * lowercased haystack, no model.
   */
  function match(text) {
    const hay = normalize(text);
    if (!hay) return null;
    for (const rule of rules) {
      for (const phrase of rule.phrases) {
        if (hay.includes(normalize(phrase))) {
          return { rule, matchedPhrase: phrase };
        }
      }
    }
    return null;
  }

  return {
    match,
    list() { return rules.map((r) => ({ ...r, phrases: [...r.phrases] })); },
    get size() { return rules.length; },

    add({ phrases, incidentType, l1, action }) {
      const clean = (Array.isArray(phrases) ? phrases : String(phrases).split(",")).map((p) => p.trim()).filter(Boolean);
      if (clean.length === 0) return { ok: false, reason: "at least one phrase is required" };
      if (!l1) return { ok: false, reason: "an L1 agent is required" };
      const rule = { id: `trg_${randomUUID().slice(0, 8)}`, phrases: clean, incidentType: incidentType || "other", l1, action: action || "" };
      rules.push(rule);
      persist();
      record({ tool: "triggers.add", outcome: "added", reason: `${clean.join("|")} -> ${l1}` });
      return { ok: true, rule };
    },

    remove(id) {
      const before = rules.length;
      rules = rules.filter((r) => r.id !== id);
      if (rules.length === before) return { ok: false, reason: "no such trigger" };
      persist();
      record({ tool: "triggers.remove", outcome: "removed", reason: id });
      return { ok: true };
    },
  };
}
