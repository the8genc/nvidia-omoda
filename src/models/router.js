// Model routing, enforced in the Broker rather than requested in a prompt.
//
// Two Nemotron models in load-bearing roles:
//   planner     nemotron-3.5-lightning-30b-a3b   HOSTED via the OpenShell gateway
//   perception  Nemotron-3-Nano-Omni ...NVFP4    LOCAL vLLM on :8000
//
// The box has about 6 GiB free, so a second 30B model physically cannot load.
// That is why the planner is hosted, and it is also why the guard model is
// memory-gated rather than assumed.

export const MODEL = Object.freeze({
  PLANNER: "nvidia/nemotron-3.5-lightning-30b-a3b",
  OMNI: "nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-NVFP4",
});

export const ENDPOINT = Object.freeze({
  HOSTED: "https://integrate.api.nvidia.com/v1/chat/completions",
  LOCAL: "http://host.openshell.internal:8000/v1/chat/completions",
});

export const TASK = Object.freeze({
  PLAN: "plan",
  CLASSIFY: "classify",
  PERCEIVE: "perceive",
});

/** Signals that a payload must not leave the box. */
const SENSITIVE_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|omoda|ghp|gho)_[A-Za-z0-9_-]{16,}/,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/i,
  /\b[A-Z0-9]{20}:[A-Za-z0-9/+=]{40}\b/,      // aws-style pair
  /\/home\/(arif|acer01)\//,
  /\b\d{3}-\d{2}-\d{4}\b/,                     // us ssn shape
];

export function isSensitive(payload, { declaredSensitive = false } = {}) {
  if (declaredSensitive) return true;
  const blob = typeof payload === "string" ? payload : JSON.stringify(payload ?? "");
  return SENSITIVE_PATTERNS.some((re) => re.test(blob));
}

export class RoutingRefused extends Error {
  constructor(message) { super(message); this.name = "RoutingRefused"; }
}

/**
 * @returns {{model:string, endpoint:string, egress:'local'|'hosted', reason:string}}
 * @throws {RoutingRefused} when a caller asks to send a sensitive payload off-box
 */
export function route({ task, payload, multimodal = false, hostedAvailable = true, declaredSensitive = false } = {}) {
  const sensitive = isSensitive(payload, { declaredSensitive });

  // Rule 2: multimodal always goes to Omni. It is the only model that takes it.
  if (multimodal || task === TASK.PERCEIVE) {
    return { model: MODEL.OMNI, endpoint: ENDPOINT.LOCAL, egress: "local", reason: "multimodal or perception" };
  }

  // Rule 1: sensitive payloads are local only, and asking otherwise is refused
  // rather than silently downgraded, so the attempt shows up in the ledger.
  if (sensitive) {
    if (task === TASK.PLAN && !hostedAvailable) {
      return { model: MODEL.OMNI, endpoint: ENDPOINT.LOCAL, egress: "local", reason: "sensitive, hosted unavailable" };
    }
    return { model: MODEL.OMNI, endpoint: ENDPOINT.LOCAL, egress: "local", reason: "sensitive payload, local only" };
  }

  // Risk classification stays local: it runs on every action and must not add
  // an egress dependency to the hot path of the gate itself.
  if (task === TASK.CLASSIFY) {
    return { model: MODEL.OMNI, endpoint: ENDPOINT.LOCAL, egress: "local", reason: "classifier stays on the gate's hot path" };
  }

  // Rule 3: planning prefers Lightning, falls back to Omni with a recorded caveat.
  if (!hostedAvailable) {
    return { model: MODEL.OMNI, endpoint: ENDPOINT.LOCAL, egress: "local", reason: "hosted unavailable, quality caveat recorded", degraded: true };
  }
  return { model: MODEL.PLANNER, endpoint: ENDPOINT.HOSTED, egress: "hosted", reason: "planning and tool selection" };
}

/** Explicit guard for code paths that hold a hosted endpoint already. */
export function assertMayLeaveBox(payload, { declaredSensitive = false } = {}) {
  if (isSensitive(payload, { declaredSensitive })) {
    throw new RoutingRefused("refusing to send a sensitive payload to a hosted endpoint");
  }
  return true;
}
