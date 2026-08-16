// The agent-action stream (/v1/out/agents): a simple live activity ticker.
//
// It shows two things per event, and only two: the agent name, and the action it
// is taking. The full story, who authorised it, why, which incident, the hash
// chain, now lives in the audit trail (/v1/out/audit and /ui/audit), so this
// stream is deliberately thin: a glanceable feed of who is doing what.
//
// describeAgent, narrateHandoff and narrateResponse remain because the audit
// projection and the response choreography still use them.

import { levelFor } from "./display.js";
import { planFor } from "../domain/response-plan.js";

const ROLE = Object.freeze({ 0: "orchestrator", 1: "domain expert", 2: "worker", 3: "tool specialist" });

/** Pretty, human name for an agent: "emergency-dispatch" -> "emergency dispatch". */
function pretty(name) {
  return String(name ?? "agent").replace(/^(coco|telegram|stream|see):/, "").replace(/[-_]/g, " ");
}

/** The bare agent name the ticker shows: "OMODA" for L0, "the operator", else the pretty name. */
function agentName(name) {
  if (name === "l0") return "OMODA";
  if (String(name).startsWith("operator")) return "the operator";
  return pretty(name).replace(/:/g, " ");
}

/** The concise action phrase: what the agent is doing, keyed off the outcome. */
function actionPhrase(entry) {
  const tool = entry.tool ?? entry.kind ?? "an action";
  const reason = entry.reason ?? null;
  const o = entry.outcome;
  if (entry.tier === "prohibited" || (o === "refused" && /prohibited|self-protection|mass-broadcast/.test(String(reason)))) return `blocked from ${tool}`;
  if (o === "escalated" || entry.consentNeeded) return `awaiting approval to run ${tool}`;
  if (o === "refused") return `refused ${tool}`;
  if (o === "executed") return `ran ${tool}`;
  if (o === "admitted") return `running ${tool}`;
  if (entry.tool === "telegram.decide") return reason === "approve" ? "approved the pending action" : "decided on the pending action";
  if (entry.tool === "telegram.undo" || o === "undone") return `reversed ${tool}`;
  if (entry.kind === "coco" || entry.kind === "coco-live") return reason || `handled ${tool}`;
  if (reason) return reason;
  return tool;
}

/** {name, level, role} plus a display phrase like "the accident domain expert (L1)". */
export function describeAgent(name, levelMap) {
  const level = levelFor(name, levelMap);
  const role = typeof level === "number" ? ROLE[level] : (level ?? null);
  // Clean phrases for the two special speakers, then the general L0-L3 form.
  let phrase;
  // L0 is the OMODA interface itself; name it, do not number it. It reads as a
  // named agent handing work to the domain experts: "OMODA handed off to ...".
  if (name === "l0") return { name, level, role: "orchestrator", phrase: "OMODA" };
  else if (level === "operator") phrase = "the operator";
  else if (typeof level === "number") phrase = `the ${pretty(name)} ${ROLE[level]} (L${level})`;
  else if (level === "input") phrase = `the ${pretty(name)} feed`;
  else phrase = `the ${pretty(name)}`;
  return { name, level, role, phrase };
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * A handoff between levels: "The accident domain expert (L1) handed off to the
 * ambulatory worker (L2) to assess whether anyone needs EMS."
 */
export function narrateHandoff({ from, to, doing, dangerous = false, intentId = null }, levelMap) {
  const a = describeAgent(from, levelMap);
  const b = describeAgent(to, levelMap);
  const selfDirected = from === to;
  const headline = selfDirected
    ? `${cap(a.phrase)} will ${doing}.`
    : `${cap(a.phrase)} handed off to ${b.phrase} to ${doing}.`
      + (dangerous ? " This is a dangerous action, so it is held for human approval." : "");
  return {
    kind: "handoff",
    headline,
    agent: { name: a.name, level: a.level, role: a.role },
    relies_on: selfDirected ? [] : [{ name: b.name, level: b.level, role: b.role }],
    doing,
    dangerous,
    intentId,
  };
}

/**
 * One ledgered action -> a ticker event: just the agent name and the action.
 * `seq` rides along for ordering and to cross-reference the full audit record.
 */
export function narrateEntry(entry) {
  return { seq: entry.seq ?? null, agent: agentName(entry.agent), action: actionPhrase(entry) };
}

/**
 * One L1 -> L3 handoff -> a ticker event: the acting agent and the work it is
 * initiating. Same two-field shape as narrateEntry, so the stream is uniform.
 */
export function handoffActivity(ev) {
  const a = ev.agent ?? {};
  const action = ev.dangerous ? `${ev.doing} (awaiting approval)` : ev.doing;
  return { seq: null, agent: agentName(a.name), action };
}

/**
 * The full narrated flow for a routed incident: the L0 -> L1 handoff, then the
 * response plan's chain down through L2 and L3. Returns an ordered array of
 * handoff narratives; the caller publishes each onto the agent stream.
 */
export function narrateResponse({ incidentType, l1, intentId }, levelMap) {
  const plan = planFor(incidentType);
  const events = [
    narrateHandoff({ from: "l0", to: l1 ?? plan.l1, doing: `take the ${pretty(incidentType)} and coordinate the response`, intentId }, levelMap),
  ];
  for (const hop of plan.chain) {
    events.push(narrateHandoff({ ...hop, intentId }, levelMap));
  }
  return events;
}
