// API authentication and the request-level security controls.
//
// S1 scoped bearer tokens        S3 HMAC signing + replay window + nonce cache
// S4 mandatory Idempotency-Key   S6 per-token rate limit
// S11 bind to the port block and the tailnet only
//
// The scope split is the security keystone: a perception feed gets
// intent:propose and nothing else, so a spoofed detection can open an intent
// but can never consent to one.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { PORT_BLOCK } from "../domain/prohibited.js";

export const SCOPES = Object.freeze({
  PROPOSE: "intent:propose",
  READ: "intent:read",
  DECIDE: "intent:decide",
  LEDGER: "ledger:read",
  HALT: "control:halt",
});

export const SIGNATURE_WINDOW_MS = 300_000; // 5 minutes

export class AuthError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.code = code;
  }
}

/** Constant-time compare that will not throw on length mismatch. */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function createTokenStore(seed = []) {
  const byToken = new Map();
  for (const t of seed) byToken.set(t.token, t);
  return {
    /** Mint a caller identity. Print once at boot, never log again (S10). */
    issue({ id, scopes, secret = randomBytes(32).toString("hex") }) {
      const token = `omoda_${randomBytes(24).toString("base64url")}`;
      const rec = { id, token, secret, scopes: [...scopes] };
      byToken.set(token, rec);
      return rec;
    },
    get(token) { return byToken.get(token) ?? null; },
    all() { return [...byToken.values()].map(({ secret, ...rest }) => rest); },
  };
}

export function createNonceCache({ ttlMs = SIGNATURE_WINDOW_MS, max = 10_000 } = {}) {
  const seen = new Map();
  return {
    /** @returns {boolean} true when this signature has not been used before */
    check(sig, now = Date.now()) {
      for (const [k, exp] of seen) { if (exp <= now) seen.delete(k); else break; }
      if (seen.has(sig)) return false;
      if (seen.size >= max) return false; // fail closed under flood
      seen.set(sig, now + ttlMs);
      return true;
    },
    get size() { return seen.size; },
  };
}

export function createRateLimiter({ capacity = 60, refillPerSec = 1 } = {}) {
  const buckets = new Map();
  return {
    take(id, now = Date.now()) {
      const b = buckets.get(id) ?? { tokens: capacity, last: now };
      const elapsed = (now - b.last) / 1000;
      b.tokens = Math.min(capacity, b.tokens + elapsed * refillPerSec);
      b.last = now;
      if (b.tokens < 1) { buckets.set(id, b); return false; }
      b.tokens -= 1;
      buckets.set(id, b);
      return true;
    },
  };
}

export function signBody(secret, timestamp, rawBody) {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

/**
 * Full request authorization. Throws AuthError with an HTTP status.
 * @returns {{caller:object}}
 */
export function authenticate({ headers, rawBody, requiredScope, tokens, nonces, limiter, now = Date.now(), requireSignature = true }) {
  const auth = headers["authorization"] ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  if (!bearer) throw new AuthError(401, "no_token", "missing bearer token");

  const caller = tokens.get(bearer);
  if (!caller) throw new AuthError(401, "bad_token", "unknown token");

  // S1: scope is checked before anything expensive happens.
  if (requiredScope && !caller.scopes.includes(requiredScope)) {
    throw new AuthError(403, "scope", `token lacks ${requiredScope}`);
  }

  // S6: per-token rate limit.
  if (limiter && !limiter.take(caller.id, now)) {
    throw new AuthError(429, "rate_limit", "rate limit exceeded");
  }

  if (requireSignature) {
    const ts = Number(headers["x-omoda-timestamp"]);
    const sig = headers["x-omoda-signature"];
    if (!Number.isFinite(ts) || !sig) throw new AuthError(401, "unsigned", "missing signature headers");

    // S3: replay window.
    if (Math.abs(now - ts * 1000) > SIGNATURE_WINDOW_MS) {
      throw new AuthError(401, "stale", "signature timestamp outside the accepted window");
    }
    const expected = signBody(caller.secret, ts, rawBody ?? "");
    if (!safeEqual(sig, expected)) throw new AuthError(401, "bad_signature", "signature mismatch");

  }

  // NOTE: the replay check is deliberately NOT done here. A legitimate
  // idempotent retry produces an identical signature when it lands inside the
  // same second, so replay protection must run AFTER idempotency has had a
  // chance to serve the cached result. See checkReplay below.
  return { caller, signature: headers["x-omoda-signature"] ?? null };
}

/**
 * S3, second half. Call this only once the request is known not to be an
 * idempotent retry of something we already answered.
 * @throws {AuthError} 409 when the signature has been seen inside the window
 */
export function checkReplay({ signature, nonces, now = Date.now() }) {
  if (!signature || !nonces) return;
  if (!nonces.check(signature, now)) {
    throw new AuthError(409, "replay", "signature already used");
  }
}

/** S11. Refuse to start on a port we do not own or an interface we should not expose. */
export function assertBindable(port, host) {
  if (!Number.isInteger(port) || port < PORT_BLOCK.min || port > PORT_BLOCK.max) {
    throw new Error(`refusing to bind ${port}: outside our block ${PORT_BLOCK.min}-${PORT_BLOCK.max}`);
  }
  if (host === "0.0.0.0" || host === "::") {
    throw new Error(`refusing to bind ${host}: the control plane of an agent platform is not public`);
  }
  return true;
}
