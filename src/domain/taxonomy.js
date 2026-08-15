// Danger taxonomy. Pure, no I/O, no dependencies.
//
// Two independent axes (PRD section 8):
//   Axis 1  the CRUD verb, DERIVED FROM THE CALL, decides which mechanism applies.
//   Axis 2  the impact domain, DECLARED in the manifest, decides who must consent.
//
// The verb is never trusted from the manifest: a write must not be able to
// masquerade as a read. Only `impact` is a declaration.

export const VERB = Object.freeze({
  READ: "read",
  CREATE: "create",
  UPDATE: "update",
  DELETE: "delete",
});

export const IMPACT = Object.freeze({
  FINANCIAL: "financial",
  LEGAL: "legal",
  REPUTATIONAL: "reputational",
});

/** Tiers the Broker can assign. Ordered least to most restricted. */
export const TIER = Object.freeze({
  SAFE: "safe", // read, autonomous, silent
  CONTAINED: "contained", // write, no impact, autonomous + ledger (+ inverse)
  CONSEQUENTIAL: "consequential", // write with impact, capability absent until consent
  UNDECLARED: "undeclared", // not in any manifest, refuse
  PROHIBITED: "prohibited", // no consent path exists, refuse + incident
});

const ALL_VERBS = new Set(Object.values(VERB));
const ALL_IMPACTS = new Set(Object.values(IMPACT));

export function isWrite(verb) {
  return verb !== VERB.READ;
}

/** Update and delete destroy a prior state, so they need a pre-image to reverse. */
export function requiresInverse(verb) {
  return verb === VERB.UPDATE || verb === VERB.DELETE;
}

export function normalizeImpact(impact) {
  if (!Array.isArray(impact)) return [];
  const seen = [];
  for (const i of impact) {
    if (ALL_IMPACTS.has(i) && !seen.includes(i)) seen.push(i);
  }
  return seen;
}

/** Reads are safe. Writes are governed. Writes with impact need recorded consent. */
export function requiresConsent(verb, impact) {
  return isWrite(verb) && normalizeImpact(impact).length > 0;
}

/**
 * Which consent stage the compiler should emit.
 *   review    reputational only
 *   approval  financial or legal
 *   two-person  delete carrying financial or legal
 */
export function consentKind(verb, impact) {
  const imp = normalizeImpact(impact);
  if (!requiresConsent(verb, imp)) return null;
  const severe = imp.includes(IMPACT.FINANCIAL) || imp.includes(IMPACT.LEGAL);
  if (!severe) return "review";
  return verb === VERB.DELETE ? "two-person" : "approval";
}

/**
 * The Broker's classification. Order is deliberate and load-bearing:
 * prohibited is checked before anything else, and undeclared before any
 * permissive path, so both fail closed.
 */
export function classify({ verb, impact = [], declared = false, prohibited = false }) {
  if (prohibited) return TIER.PROHIBITED;
  if (!declared) return TIER.UNDECLARED;
  if (!ALL_VERBS.has(verb)) return TIER.UNDECLARED;
  if (!isWrite(verb)) return TIER.SAFE;
  return requiresConsent(verb, impact) ? TIER.CONSEQUENTIAL : TIER.CONTAINED;
}

/** HTTP methods an OpenShell fragment may grant for a capability. */
export function methodsFor(verb, impact) {
  if (!isWrite(verb)) return ["GET"];
  // A consequential write compiles to read-only. The write method is absent
  // until a recorded decision materializes it.
  if (requiresConsent(verb, impact)) return ["GET"];
  if (verb === VERB.CREATE) return ["POST"];
  if (verb === VERB.UPDATE) return ["POST", "PUT", "PATCH"];
  return ["DELETE"];
}
