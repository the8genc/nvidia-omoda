// Human-prose narration for the agent-action stream (/v1/out/agents).
//
// The dashboard shows this to a person, so each event leads with a sentence:
// who is acting, what they are doing right now, and who they are relying on.
// The structured fields stay for the UI to style, but the headline is the point.

import { levelFor } from "./display.js";
import { planFor } from "../domain/response-plan.js";

const ROLE = Object.freeze({ 0: "orchestrator", 1: "domain expert", 2: "worker", 3: "tool specialist" });

/** Pretty, human name for an agent: "emergency-dispatch" -> "emergency dispatch". */
function pretty(name) {
  return String(name ?? "agent").replace(/^(coco|telegram|stream|see):/, "").replace(/[-_]/g, " ");
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
 * A ledgered action, as a sentence. Covers the broker outcomes, consent,
 * prohibited refusals, undo, and the perception/describe reads.
 */
export function narrateEntry(entry, levelMap) {
  const a = describeAgent(entry.agent, levelMap);
  const tool = entry.tool ?? "an action";
  const reason = entry.reason ?? null;
  const tier = entry.tier ?? entry.kind ?? null;

  let headline;
  if (tier === "prohibited" || entry.outcome === "refused" && /prohibited|self-protection|mass-broadcast/.test(String(reason))) {
    headline = `${cap(a.phrase)} attempted ${tool}, which is prohibited, and was blocked.`;
  } else if (entry.outcome === "escalated" || entry.consentNeeded) {
    headline = `${cap(a.phrase)} needs human approval before it can ${tool}; the capability does not exist until then.`;
  } else if (entry.outcome === "refused") {
    headline = `${cap(a.phrase)} was refused: ${reason ?? "not permitted"}.`;
  } else if (entry.outcome === "executed") {
    headline = `${cap(a.phrase)} completed ${tool}.`;
  } else if (entry.outcome === "admitted") {
    headline = `${cap(a.phrase)} is carrying out ${tool}.`;
  } else if (entry.tool === "telegram.decide") {
    headline = `The operator ${reason === "approve" ? "approved" : "decided on"} the pending action.`;
  } else if (entry.tool === "telegram.undo" || entry.outcome === "undone") {
    headline = `${cap(a.phrase)} reversed ${tool}.`;
  } else if (entry.kind === "coco-live" || entry.kind === "coco") {
    headline = `${cap(a.phrase)} ${reason ? reason : `handled ${tool}`}.`;
  } else if (reason) {
    headline = `${cap(a.phrase)} ${reason}.`;
  } else {
    headline = `${cap(a.phrase)} performed ${tool}.`;
  }

  return {
    kind: "action",
    headline,
    seq: entry.seq,
    agent: { name: a.name, level: a.level, role: a.role },
    action: `${entry.verb ? entry.verb + " " : ""}${entry.tool ?? "-"}`.trim(),
    instruction: reason,
    outcome: entry.outcome ?? null,
    tier,
    intentId: entry.intentId ?? null,
  };
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
