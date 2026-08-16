// The agentic audit stream (/v1/out/audit).
//
// A projection of the audit trail (the hash-chained ledger) into the exact shape
// the demo dashboard consumes. One record per audit-worthy event, with the eight
// fields the demo asks for:
//
//   time       when the event took place (ISO 8601)
//   agent      which agent acted (raw name + a human display)
//   tool       the tool it used
//   trigger    the trigger word, split into verb (the CRUD verb) and noun (the
//              resource), plus the take-action phrase that opened the incident
//   tier       the agent's rank, L0 to L3 (or operator / input)
//   authority  who authorised it: a person for a consented action, the envelope
//              for an autonomous one, or none for a refusal
//   outcome    what happened
//   intent     why the agent acted: the incident it belongs to, and the reason
//
// What is DELIBERATELY absent: a motor quietly reviewing frames that trigger
// nothing. The audit trail begins when L0 (OMODA) sees something that triggers
// it, and then captures every downstream L1 -> L2 -> L3 engagement. Quiet frames
// are never ledgered, and perception / knowledge / admin reads are filtered out
// here, so the trail is the response, not the watching.

import { describeAgent } from "./narrate.js";

// Ledger entries that are NOT part of a triggered response chain. Perception and
// knowledge reads are how the platform watches and thinks; admin, api, control,
// and telegram are operator plumbing; the judge's own verdict rows are detection
// mechanics. The L0 routing entry already carries the trigger, so the judge rows
// are redundant here.
const NON_AUDIT_KINDS = new Set([
  "coco", "coco-live", "frame", "observation",
  "knowledge", "triggers", "api", "control", "telegram", "judge",
]);

/**
 * Is this ledger record part of the triggered response chain the audit trail
 * exists to show? Quiet frames never reach the ledger, so the main job here is to
 * drop the perception/admin noise and the broker's duplicate pre-execution row.
 */
export function isAuditWorthy(entry) {
  if (!entry) return false;
  if (NON_AUDIT_KINDS.has(entry.kind)) return false;
  // The broker writes an "admitted" row before it acts, then a terminal row with
  // the real outcome. For auto-run tiers the terminal row is the one worth
  // showing, so the pre-row is a duplicate. For a consequential write there is no
  // terminal row until a decision arrives, so its "admitted" row IS the event
  // (an escalation awaiting approval); keep that one.
  if (entry.outcome === "admitted" && (entry.tier === "safe" || entry.tier === "contained")) return false;
  return true;
}

/** The resource noun: an explicit resource, else the tool's resource segment. */
function nounFor(entry) {
  if (entry.resource) return String(entry.resource);
  const tool = String(entry.tool ?? "");
  const parts = tool.split(".");
  if (parts.length >= 2) return parts[parts.length - 2]; // dispatch.unit.request -> unit
  return tool || null;
}

/** The take-action phrase or the incident type that opened the flow, if known. */
function phraseFor(entry) {
  if (entry.triggerPhrase) return String(entry.triggerPhrase);
  // The L0 routing entry's reason is "<incidentType> -> <l1>"; surface the type
  // as the trigger when no literal phrase was recorded.
  if (entry.kind === "orchestrator" && typeof entry.reason === "string" && entry.reason.includes(" -> ")) {
    return entry.reason.split(" -> ")[0].trim();
  }
  return null;
}

/** Who authorised the action. A person for a decision, else the mechanism. */
function authorityFor(entry) {
  const a = entry.authority;
  if (!a) return { kind: "none", who: null };
  if (a.startsWith("decision:")) return { kind: "operator", who: entry.decidedBy ?? null, ref: a.slice("decision:".length) };
  if (a.startsWith("operator")) return { kind: "operator", who: a.includes(":") ? a.split(":").slice(1).join(":") : null };
  if (a === "envelope") return { kind: "envelope", who: null };   // autonomous, no person
  if (a === "pending") return { kind: "pending", who: null };     // awaiting a person
  return { kind: a, who: null };                                   // denied / prohibited / incident
}

/** Tier as the demo shows it: a level 0-3, or a named non-agent role. */
function tierFor(agentName, levelMap) {
  const { level, role } = describeAgent(agentName, levelMap);
  const label = typeof level === "number" ? `L${level}` : (level ?? "unknown");
  return { level: level ?? null, label, role: role ?? null };
}

/**
 * One ledger record -> the eight-field audit event. `seq` and `hash` ride along
 * so the demo can prove a row is a durable, hash-chained audit record.
 */
export function ledgerToAudit(entry, levelMap) {
  const who = describeAgent(entry.agent, levelMap);
  const authority = authorityFor(entry);
  const outcome = entry.outcome === "admitted" && authority.kind === "pending"
    ? "awaiting-approval"
    : (entry.outcome ?? null);
  return {
    time: entry.at ?? null,
    agent: { name: who.name, display: who.phrase },
    tool: entry.tool ?? null,
    trigger: { verb: entry.verb ?? null, noun: nounFor(entry), phrase: phraseFor(entry) },
    tier: tierFor(entry.agent, levelMap),
    authority,
    outcome,
    intent: { id: entry.intentId ?? null, why: entry.reason ?? null },
    // provenance: present when the row is a durable ledger record
    source: "ledger",
    seq: entry.seq ?? null,
    hash: entry.hash ?? null,
  };
}

/**
 * One L1 -> L2 -> L3 handoff (from narrateResponse) -> the same audit shape. This
 * is the agent-to-agent information flow: who handed what to whom, and why. It is
 * the engagement, not a durable ledger row, so seq/hash are absent.
 */
export function handoffToAudit(ev, levelMap, { at = null } = {}) {
  const a = ev.agent ?? {};
  const target = ev.relies_on?.[0] ?? null;
  return {
    time: ev.at ?? at,
    agent: { name: a.name ?? null, display: describeAgent(a.name, levelMap).phrase },
    tool: null, // a handoff delegates; the tool call happens at the L3 it reaches
    trigger: { verb: "delegate", noun: target?.name ?? null, phrase: null },
    tier: tierFor(a.name, levelMap),
    authority: ev.dangerous ? { kind: "pending", who: null } : { kind: "envelope", who: null },
    outcome: ev.dangerous ? "awaiting-approval" : "handed-off",
    intent: { id: ev.intentId ?? null, why: ev.doing ?? ev.headline ?? null },
    relies_on: target ? { name: target.name, tier: tierFor(target.name, levelMap) } : null,
    source: "engagement",
    seq: null,
    hash: null,
  };
}
