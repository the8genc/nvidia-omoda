// The Action API. Six endpoints, node:http, no framework.
//
// Telegram is a client of this. The See project is a client of this. Paperclip
// would be a client of this. Making the API the intake rather than any one
// channel is what makes the platform embeddable, and it removes the dependency
// on a single transport being up.

import { createServer } from "node:http";
import { z } from "zod";
import {
  SCOPES, AuthError, authenticate, checkReplay, assertBindable,
  createTokenStore, createNonceCache, createRateLimiter,
} from "./auth.js";
import { createIntentStore, INTENT_STATE } from "./intents.js";
import { createLedger } from "../ledger/ledger.js";
import { randomBytes } from "node:crypto";
import { render, SkillsPage, IntentsPage, LedgerPage, AgentNewPage } from "../web/ui.js";
import { checkAdminAuth, unauthorized } from "../web/admin-auth.js";
import { safeParseManifest } from "../schema/manifest.js";
import { compile } from "../policy/compile.js";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ProposeBody = z.object({
  source: z.string().min(1).optional(),
  kind: z.enum(["detection", "task"]).default("task"),
  detector: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  observed_at: z.string().optional(),
  evidence: z.record(z.unknown()).default({}),
  requested_outcome: z.string().min(1),
}).strict(); // S5

const DecisionBody = z.object({
  verdict: z.enum(["approve", "deny"]),
  reason: z.string().min(1),
  action_id: z.string().min(1),
}).strict();

// PUT: an update to something previously posted. Strict, so a body carrying
// decisions (or anything else) is a schema error before it is a semantic one.
const UpdateBody = z.object({
  requested_outcome: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  evidence: z.record(z.unknown()).optional(),
}).strict();

const json = (res, status, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    // Defensive headers even on a tailnet-only control plane.
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
  res.end(body);
};

async function readBody(req, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new AuthError(413, "too_large", "body too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createApp({
  tokens, ledger, intents, nonces, limiter, skills = [], uiOperator = null,
  skillsDir = "skills",
  // How "apply now" takes effect. The default exits non-zero after the response
  // has flushed, so systemd (Restart=on-failure) brings the service back with
  // the new skill loaded. Injected so tests never kill their own process.
  onApply = () => setTimeout(() => process.exit(64), 400),
  adminCreds = undefined,
} = {}) {
  // The UI is server-rendered and acts on the operator's behalf server-side, so
  // the operator credential never reaches a browser. CSRF is a per-process
  // token because this control plane is single-operator and tailnet-only.
  const csrf = randomBytes(16).toString("hex");
  tokens ??= createTokenStore();
  ledger ??= createLedger({});
  intents ??= createIntentStore();
  nonces ??= createNonceCache();
  limiter ??= createRateLimiter();

  async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    const method = req.method;

    if (path === "/healthz" && method === "GET") return json(res, 200, { ok: true, status: "live" });

    // ── server-rendered UI ────────────────────────────────────────────────
    const html = (status, markup) => {
      res.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
        "cache-control": "no-store",
      });
      res.end(markup);
    };

    // The portal can write (deploying an agent provisions capability), so every
    // /ui route sits behind Basic auth. API routes keep their own token auth.
    if (path === "/ui" || path.startsWith("/ui/")) {
      if (!checkAdminAuth(req.headers, adminCreds).ok) return unauthorized(res);
    }

    if (path === "/ui" && method === "GET") {
      return html(200, render(SkillsPage({ skills, deployed: url.searchParams.get("deployed") })));
    }
    if (path === "/ui/agents/new" && method === "GET") {
      return html(200, render(AgentNewPage({ csrf })));
    }
    if (path === "/ui/agents/new" && method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      if (form.get("csrf") !== csrf) return html(403, "<p>bad csrf token</p>");
      const prefill = Object.fromEntries(form.entries());
      const fail = (error) => html(422, render(AgentNewPage({ csrf, error, prefill })));

      let capabilities = [];
      const capsRaw = (form.get("capabilities") ?? "").trim();
      if (capsRaw) {
        try {
          capabilities = parseYaml(capsRaw);
          if (!Array.isArray(capabilities)) return fail("capabilities must be a YAML list");
        } catch (err) {
          return fail(`capabilities is not valid YAML: ${String(err.message).slice(0, 200)}`);
        }
      }

      const manifest = {
        skill: (form.get("skill") ?? "").trim(),
        agent: (form.get("agent") ?? "").trim(),
        level: Number(form.get("level") ?? 2),
        inference: form.get("inference") === "yes",
        ...(form.get("description")?.trim() ? { description: form.get("description").trim() } : {}),
        capabilities,
      };

      // The same gate the loader applies at boot: schema (levels included), then
      // a full compile. A manifest that would refuse to boot refuses to deploy.
      const parsed = safeParseManifest(manifest);
      if (!parsed.success) return fail(parsed.error.issues.map((i) => i.message).join("; ").slice(0, 400));
      try { compile(parsed.data); }
      catch (err) { return fail(`manifest does not compile: ${String(err.message).slice(0, 300)}`); }

      const dir = join(skillsDir, parsed.data.skill);
      if (existsSync(dir)) return fail(`skill "${parsed.data.skill}" already exists; deploys never overwrite an enabled agent`);

      const instructions = (form.get("instructions") ?? "").trim();
      const md = `---\n${stringifyYaml(manifest)}---\n${instructions ? instructions + "\n" : ""}`;
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "omoda.skill.md"), md, { mode: 0o644 });
      } catch (err) {
        return html(500, render(AgentNewPage({ csrf, error: `write failed: ${err.message}`, prefill })));
      }

      const applyNow = form.get("apply_now") === "yes";
      try {
        ledger.append({
          kind: "ui", agent: uiOperator?.id ?? "admin", tool: "ui.agent.deploy", verb: "create",
          outcome: "deployed", reason: `${parsed.data.skill} level=${parsed.data.level} applyNow=${applyNow}`,
        });
      } catch {
        return html(503, "<p>ledger unavailable; refusing to deploy unlogged</p>");
      }

      res.writeHead(303, { location: `/ui?deployed=${encodeURIComponent(parsed.data.skill)}` });
      res.end();
      if (applyNow) onApply();
      return;
    }
    if (path === "/ui/intents" && method === "GET") {
      return html(200, render(IntentsPage({ intents: intents.all(), csrf })));
    }
    if (path === "/ui/ledger" && method === "GET") {
      return html(200, render(LedgerPage({ entries: ledger.query({ limit: 200 }), chain: ledger.verify() })));
    }
    if (path === "/ui/decide" && method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      if (form.get("csrf") !== csrf) return html(403, "<p>bad csrf token</p>");
      if (!uiOperator) return html(503, "<p>no operator identity configured for the UI</p>");
      const out = intents.decide({
        intentId: form.get("intent_id"),
        actionId: form.get("action_id"),
        verdict: form.get("verdict"),
        reason: form.get("reason"),
        caller: uiOperator,
      });
      ledger.append({
        kind: "ui", agent: uiOperator.id, tool: "ui.decide", verb: "update",
        outcome: out.ok ? "recorded" : "refused", reason: out.ok ? form.get("verdict") : out.reason,
      });
      res.writeHead(303, { location: "/ui/intents" });
      return res.end();
    }

    let raw = "";
    try {
      if (method === "POST" || method === "PUT") raw = await readBody(req);
    } catch (err) {
      return json(res, err.status ?? 400, { error: err.code ?? "bad_body" });
    }

    const scopeFor = () => {
      if (path === "/v1/intents" && method === "POST") return SCOPES.PROPOSE;
      if (path.startsWith("/v1/intents/") && path.endsWith("/decisions")) return SCOPES.DECIDE;
      // An update to a previously posted engagement is proposer-side work, and
      // the store additionally binds it to the exact proposing identity.
      if (path.startsWith("/v1/intents/") && method === "PUT") return SCOPES.PROPOSE;
      if (path.startsWith("/v1/intents/")) return SCOPES.READ;
      if (path === "/v1/ledger") return SCOPES.LEDGER;
      if (path === "/v1/halt") return SCOPES.HALT;
      return null;
    };

    const required = scopeFor();
    if (required === null) return json(res, 404, { error: "not_found" });

    let caller, signature;
    try {
      ({ caller, signature } = authenticate({
        headers: req.headers,
        rawBody: raw,
        requiredScope: required,
        tokens, nonces, limiter,
        requireSignature: method === "POST" || method === "PUT",
      }));
    } catch (err) {
      if (err instanceof AuthError) return json(res, err.status, { error: err.code, message: err.message });
      throw err;
    }

    // Non-propose POSTs have no idempotency semantics, so replay protection
    // applies immediately.
    if ((method === "POST" && path !== "/v1/intents") || method === "PUT") {
      try { checkReplay({ signature, nonces }); }
      catch (err) { return json(res, err.status, { error: err.code, message: err.message }); }
    }

    // S12: every authenticated call is evidence, recorded with caller identity.
    try {
      ledger.append({ kind: "api", agent: caller.id, tool: `${method} ${path}`, verb: "read", outcome: "received" });
    } catch {
      return json(res, 503, { error: "ledger_unavailable", message: "refusing to serve unlogged" });
    }

    // POST /v1/intents
    if (path === "/v1/intents" && method === "POST") {
      const idem = req.headers["idempotency-key"];
      if (!idem) return json(res, 400, { error: "idempotency_required", message: "Idempotency-Key header is mandatory" });
      let body;
      try { body = ProposeBody.parse(JSON.parse(raw)); }
      catch (err) { return json(res, 422, { error: "schema", message: String(err.message).slice(0, 400) }); }

      const { intent, duplicate } = intents.propose({ idempotencyKey: idem, body, caller });

      // S3 + S4 interact here. An idempotent retry legitimately carries the
      // same signature, so replay protection runs only when this is NOT a
      // known key. Serving the cached intent is the correct answer to a retry;
      // 409 would make a well-behaved client look like an attacker.
      if (!duplicate) {
        try { checkReplay({ signature, nonces }); }
        catch (err) { return json(res, err.status, { error: err.code, message: err.message }); }
      }

      // 202, never 200. Proposing is not doing.
      return json(res, 202, { intent_id: intent.id, state: intent.state, duplicate });
    }

    // PUT /v1/intents/{id}: an update to something previously posted (PRD 23.1)
    const putMatch = path.match(/^\/v1\/intents\/([^/]+)$/);
    if (putMatch && method === "PUT") {
      let body;
      try { body = UpdateBody.parse(JSON.parse(raw)); }
      catch (err) { return json(res, 422, { error: "schema", message: String(err.message).slice(0, 400) }); }

      const out = intents.update({ intentId: putMatch[1], body, caller });
      try {
        ledger.append({
          kind: "api", agent: caller.id, tool: "intents.update", verb: "update",
          outcome: out.ok ? "updated" : "refused", reason: out.ok ? undefined : out.reason,
          intentId: putMatch[1],
        });
      } catch {
        return json(res, 503, { error: "ledger_unavailable", message: "refusing to serve unlogged" });
      }
      if (!out.ok) return json(res, out.status, { error: "update_refused", message: out.reason });
      return json(res, 200, { intent_id: out.intent.id, state: out.intent.state, updates: out.intent.updates.length });
    }

    // POST /v1/intents/{id}/decisions
    const decMatch = path.match(/^\/v1\/intents\/([^/]+)\/decisions$/);
    if (decMatch && method === "POST") {
      let body;
      try { body = DecisionBody.parse(JSON.parse(raw)); }
      catch (err) { return json(res, 422, { error: "schema", message: String(err.message).slice(0, 400) }); }

      const out = intents.decide({
        intentId: decMatch[1], actionId: body.action_id,
        verdict: body.verdict, reason: body.reason, caller,
      });
      if (!out.ok) return json(res, out.status, { error: "decision_refused", message: out.reason });
      return json(res, 201, { decision_id: out.decision.decisionId, verdict: out.decision.verdict, expires_at: out.decision.expiresAt });
    }

    // GET /v1/intents/{id}
    const getMatch = path.match(/^\/v1\/intents\/([^/]+)$/);
    if (getMatch && method === "GET") {
      const intent = intents.get(getMatch[1]);
      if (!intent) return json(res, 404, { error: "not_found" });
      return json(res, 200, intent);
    }

    // GET /v1/ledger
    if (path === "/v1/ledger" && method === "GET") {
      const q = Object.fromEntries(url.searchParams);
      return json(res, 200, { entries: ledger.query({ ...q, limit: Number(q.limit) || 100 }), chain: ledger.verify() });
    }

    // POST /v1/halt
    if (path === "/v1/halt" && method === "POST") {
      ledger.append({ kind: "control", agent: caller.id, tool: "HALT", verb: "update", outcome: "halted" });
      return json(res, 200, { halted: true, at: new Date().toISOString() });
    }

    return json(res, 405, { error: "method_not_allowed" });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      // S13: an unexpected error is a refusal, never a partial success.
      try { json(res, 500, { error: "internal", message: "refused" }); } catch {}
      process.emitWarning(`api error: ${err.message}`);
    });
  });

  return { server, tokens, ledger, intents, handle };
}

export function listen({ port = 3110, host = "127.0.0.1", ...rest } = {}) {
  assertBindable(port, host); // S11
  const app = createApp(rest);
  return new Promise((resolve) => app.server.listen(port, host, () => resolve(app)));
}
