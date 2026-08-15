// The prohibited list. No decision path exists for anything matched here.
// Checked BEFORE the envelope and before any consent logic, so a valid
// recorded decision can never reach it. Pure, no I/O.
//
// PRD section 9.5.

export const PORT_BLOCK = Object.freeze({ min: 3100, max: 3199 });

/** Ports owned by other people on the shared box, and the shared services. */
export const SHARED_PORTS = Object.freeze([8000, 8080, 11000, 11002, 18789, 18790]);

const SHARED_PATHS = [
  "/home/acer01",
  "/var/run/docker.sock",
  "/run/docker.sock",
];

const POLICY_WEAKENERS = [
  "managed_inference",
  "personal-open-internet",
  "disable-device-auth",
  "device_auth_disabled",
];

/**
 * The OpenClaw gateway's own control plane, reachable now that we are paired.
 *
 * These are the methods that would let the Broker dismantle, or hand away, the
 * enforcement its own authority rests on: turning off the gateway's execution
 * approvals, rewriting its config, rotating or revoking device tokens, or
 * approving somebody else's device. An operator tap cannot authorise any of
 * them, because a consent path that can disable the consent mechanism is a
 * privilege escalation ladder rather than a control.
 *
 * Note what is NOT here: agents.create, cron.add, skills.upload. Those are
 * ordinary consequential writes. They are dangerous, so they need a recorded
 * decision; they are not self-referential, so a decision is sufficient.
 */
const GATEWAY_CONTROL_PLANE = [
  "exec.approvals.set",
  "exec.approvals.node.set",
  "config.set",
  "config.apply",
  "config.patch",
  "device.token.rotate",
  "device.token.revoke",
  "device.pair.approve",
  "device.pair.remove",
  "node.pair.approve",
  "node.pair.remove",
];

export class Prohibited extends Error {
  constructor(rule, detail) {
    super(`prohibited: ${rule}${detail ? ` (${detail})` : ""}`);
    this.name = "Prohibited";
    this.rule = rule;
    this.detail = detail ?? null;
  }
}

export function portAllowed(port) {
  return Number.isInteger(port) && port >= PORT_BLOCK.min && port <= PORT_BLOCK.max;
}

function hfHome() {
  return process.env.HF_HOME || "/home/acer01/.cache/huggingface";
}

/**
 * Returns a rule name when the action is prohibited, otherwise null.
 * Deliberately returns a REASON rather than a boolean so the ledger and the
 * incident alert can both name the rule that fired.
 */
export function prohibitedReason(action = {}) {
  const { port, path: targetPath, tool = "", args = {}, policyDelta = null } = action;

  // 1 + 2: ports. Anything outside our block, including the shared services.
  if (port !== undefined && port !== null) {
    if (!portAllowed(port)) {
      return SHARED_PORTS.includes(port) ? "shared-service-port" : "port-outside-block";
    }
  }

  // 3 + 4: shared filesystem and the host container runtime.
  const paths = [targetPath, args.path, args.cwd, args.file].filter(Boolean);
  for (const p of paths) {
    const s = String(p);
    if (s.startsWith(hfHome())) return "model-cache";
    for (const shared of SHARED_PATHS) {
      if (s === shared || s.startsWith(shared + "/")) return "shared-path";
    }
  }

  // 5: credential exfiltration.
  if (/gateway.*(config|secret)|env\s*\|\s*curl|printenv.*http/i.test(String(args.cmd || ""))) {
    return "credential-exfiltration";
  }

  // 6: the self-protection clause. A delta that would dismantle the thing
  // whose authority the Broker derives from.
  if (policyDelta) {
    const blob = JSON.stringify(policyDelta).toLowerCase();
    for (const w of POLICY_WEAKENERS) {
      if (blob.includes(w)) return "policy-weakening";
    }
    // Adding an inference provider host directly bypasses credential brokering.
    if (/integrate\.api\.nvidia\.com|api\.openai\.com|api\.anthropic\.com/.test(blob)) {
      return "inference-host-direct";
    }
  }

  // 7: the gateway's own control plane. Same clause as 6, one layer out: 6
  // protects the OpenShell envelope, this protects the gateway that enforces it.
  if (tool.startsWith("openclaw.")) {
    const method = tool.slice("openclaw.".length);
    if (GATEWAY_CONTROL_PLANE.includes(method)) return "gateway-self-protection";
  }

  // 8: destructive git on refs we do not own.
  if (tool === "git.push" || tool === "git.branch") {
    const ref = String(args.ref || args.branch || "");
    const force = Boolean(args.force);
    if (force && /(^|\/)(main|master)$/.test(ref)) return "force-push-shared-ref";
    if (args.delete && !ref.startsWith("omoda/") && !ref.startsWith("arif/")) {
      return "delete-foreign-branch";
    }
  }

  return null;
}

export function assertNotProhibited(action) {
  const rule = prohibitedReason(action);
  if (rule) throw new Prohibited(rule, action.tool);
}
