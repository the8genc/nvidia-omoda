// S8. Evidence and fetched content are UNTRUSTED input.
//
// A vision detector is an input channel an adversary reaches by placing an
// object in front of a camera. Treat a detection exactly like a fetched web
// page: useful, unauthenticated as to intent, never authoritative.
//
// Two defences, both structural rather than model-based:
//   1. never interpolate untrusted text into a shell command or a policy path
//   2. strip instruction-shaped content before it reaches planner context

const INJECTION_PATTERNS = [
  /ignore (?:all )?(?:previous|prior|above) instructions/i,
  /disregard (?:the )?(?:system|previous) prompt/i,
  /you are now (?:a|an|in) /i,
  /\bsystem\s*:\s*/i,
  /<\|(?:im_start|im_end|system)\|>/i,
  /\bapprove\b.{0,40}\b(?:this|the)\b.{0,20}\b(?:action|intent|request)\b/i,
  /\bgrant\b.{0,30}\b(?:access|permission|scope)\b/i,
];

// Anything that could change the meaning of a command if interpolated.
const SHELL_METACHARACTERS = /[;&|`$<>(){}\\\n\r]/;

export class UnsafeEvidence extends Error {
  constructor(message) { super(message); this.name = "UnsafeEvidence"; }
}

/** @returns {{clean:string, flags:string[]}} */
export function screenText(input, { maxLen = 4000 } = {}) {
  const raw = String(input ?? "");
  const flags = [];
  let clean = raw.slice(0, maxLen);
  if (raw.length > maxLen) flags.push("truncated");

  for (const re of INJECTION_PATTERNS) {
    if (re.test(clean)) {
      flags.push("instruction-shaped");
      clean = clean.replace(re, "[redacted: instruction-shaped content]");
    }
  }
  return { clean, flags };
}

/**
 * Screen a whole evidence object. Returns a copy safe to place in planner
 * context, plus the flags so the ledger records that screening happened.
 */
export function screenEvidence(evidence = {}) {
  const flags = new Set();
  const out = {};
  for (const [k, v] of Object.entries(evidence)) {
    if (typeof v === "string") {
      const { clean, flags: f } = screenText(v);
      out[k] = clean;
      f.forEach((x) => flags.add(`${k}:${x}`));
    } else if (v && typeof v === "object") {
      const nested = screenEvidence(v);
      out[k] = nested.evidence;
      nested.flags.forEach((x) => flags.add(`${k}.${x}`));
    } else {
      out[k] = v;
    }
  }
  return { evidence: out, flags: [...flags] };
}

/**
 * The hard rule: untrusted text never becomes part of a command or a path.
 * Callers must pass evidence as ARGUMENTS, never by interpolation.
 */
export function assertNotInterpolated(value, { field = "value" } = {}) {
  const s = String(value ?? "");
  if (SHELL_METACHARACTERS.test(s)) {
    throw new UnsafeEvidence(`${field} contains shell metacharacters and must not be interpolated`);
  }
  if (s.includes("..")) {
    throw new UnsafeEvidence(`${field} contains a path traversal and must not be interpolated`);
  }
  return true;
}
