// HTTP Basic auth for the admin portal (/ui).
//
// The portal can now WRITE (deploying an agent provisions capability), so it
// stops being an anonymous read-only view. Basic auth over the tailnet-only,
// loopback-bound control plane is proportionate: the browser prompts, the
// credential never lands in a form or a cookie, and the API routes keep their
// own token auth untouched.
//
// The default credential below is exactly that: a DEFAULT, printed in the team
// documentation on purpose so the team can reach the portal, and expected to be
// rotated with the other demo credentials (issue #18). Override without touching
// code: OMODA_ADMIN_USER / OMODA_ADMIN_PASS in the environment or .env.

import { timingSafeEqual } from "node:crypto";

export const DEFAULT_ADMIN_USER = "omoda-admin";
export const DEFAULT_ADMIN_PASS = "SparkDo-OMODA-2026";

function safeEqual(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  // Compare against self when lengths differ so timing stays flat.
  return ab.length === bb.length ? timingSafeEqual(ab, bb) : (timingSafeEqual(ab, ab), false);
}

/**
 * @returns {{ok:true, user:string} | {ok:false}}
 */
export function checkAdminAuth(headers = {}, {
  user = process.env.OMODA_ADMIN_USER ?? DEFAULT_ADMIN_USER,
  pass = process.env.OMODA_ADMIN_PASS ?? DEFAULT_ADMIN_PASS,
} = {}) {
  const auth = headers["authorization"] ?? "";
  if (!auth.startsWith("Basic ")) return { ok: false };
  let decoded;
  try { decoded = Buffer.from(auth.slice(6).trim(), "base64").toString("utf8"); }
  catch { return { ok: false }; }
  const i = decoded.indexOf(":");
  if (i === -1) return { ok: false };
  const gotUser = decoded.slice(0, i), gotPass = decoded.slice(i + 1);
  if (!safeEqual(gotUser, user) || !safeEqual(gotPass, pass)) return { ok: false };
  return { ok: true, user: gotUser };
}

export function unauthorized(res) {
  res.writeHead(401, {
    "www-authenticate": 'Basic realm="OMODA admin", charset="UTF-8"',
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end("authentication required");
}
