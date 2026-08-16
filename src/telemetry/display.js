// The compact projection for the agent-action stream (/v1/out/agents).
//
// The ledger record is complete and hash-chained; that lives on disk and on
// /v1/ledger. The dashboard does not need all of it. This trims each action to
// the four things a viewer reads at a glance, plus the two the UI needs to
// order and colour: seq and tier. The full record is one lookup away by seq.

// Agents that are not skills still have a level in the org chart.
const SPECIAL_LEVELS = Object.freeze({
  l0: 0,
  "omoda:judge": 0,        // the judge is L0's detection engine
  "omoda:integration": 3,  // gateway/tool connectivity
});

/**
 * @param {string} agent            the ledger entry's agent field
 * @param {Map<string,number>} skillLevels  agent-name -> level, from the manifests
 * @returns {number|string|null}    a level number, "operator" for the human, or null
 */
export function levelFor(agent, skillLevels) {
  if (!agent) return null;
  if (agent.startsWith("operator")) return "operator";
  if (agent.startsWith("coco")) return "input";         // the See side / camera
  if (agent.startsWith("telegram")) return "input";     // an operator engagement
  if (agent.startsWith("stream:") || agent.startsWith("see:")) return "input";
  if (agent in SPECIAL_LEVELS) return SPECIAL_LEVELS[agent];
  const lvl = skillLevels?.get(agent);
  return lvl === undefined ? null : lvl;
}

/**
 * Ledger record -> the compact agent-action event the dashboard displays.
 * @returns {{seq, name, level, action, instruction, outcome, tier}}
 */
export function toAgentDisplay(entry, skillLevels) {
  const verb = entry.verb ? `${entry.verb} ` : "";
  return {
    seq: entry.seq,
    // the four the dashboard cares about
    name: entry.agent ?? "unknown",
    level: levelFor(entry.agent, skillLevels),
    action: `${verb}${entry.tool ?? "-"}`.trim(),      // what it is doing
    instruction: entry.reason ?? null,                  // what it was told to do
    // two for the UI's own use
    outcome: entry.outcome ?? null,
    tier: entry.tier ?? entry.kind ?? null,
  };
}

/** Build the agent-name -> level map from loaded skills. */
export function skillLevelMap(skills = []) {
  const m = new Map();
  for (const s of skills) if (s.agent) m.set(s.agent, s.level ?? 2);
  return m;
}
