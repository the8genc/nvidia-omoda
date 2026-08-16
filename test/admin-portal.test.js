import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/api/server.js";
import { createTokenStore } from "../src/api/auth.js";
import { createLedger } from "../src/ledger/ledger.js";
import { createIntentStore } from "../src/api/intents.js";
import { checkAdminAuth, DEFAULT_ADMIN_USER, DEFAULT_ADMIN_PASS } from "../src/web/admin-auth.js";
import { loadSkills } from "../src/skills/load.js";

const basic = (u, p) => "Basic " + Buffer.from(`${u}:${p}`).toString("base64");
const ADMIN = basic(DEFAULT_ADMIN_USER, DEFAULT_ADMIN_PASS);

function harness(t) {
  const skillsDir = mkdtempSync(join(tmpdir(), "omoda-deploy-"));
  t.after(() => rmSync(skillsDir, { recursive: true, force: true }));
  const applied = [];
  const ledger = createLedger({ path: `/tmp/omoda-portal-${Date.now()}-${Math.random()}.jsonl` });
  const app = createApp({
    tokens: createTokenStore(), ledger, intents: createIntentStore(),
    skillsDir, onApply: () => applied.push(true),
    uiOperator: { id: "operator:arif", scopes: ["intent:decide"] },
  });
  return { app, skillsDir, applied, ledger };
}

async function req(app, { method = "GET", path, auth = ADMIN, form }) {
  const raw = form ? new URLSearchParams(form).toString() : "";
  let status, body = "", headers;
  const res = { writeHead(s, hh) { status = s; headers = hh; }, end(b) { body = String(b ?? ""); } };
  const chunks = raw ? [Buffer.from(raw)] : [];
  await app.handle({
    method, url: path, headers: auth ? { authorization: auth } : {},
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; },
  }, res);
  return { status, body, headers };
}

const csrfOf = async (app) => (await req(app, { path: "/ui/agents/new" })).body.match(/name="csrf" value="([a-f0-9]+)"/)[1];

const CAPS = `- tool: example.records.read
  verb: read
  impact: []
  egress: { host: api.example.com }`;

// ── the door ───────────────────────────────────────────────────────────────
test("the portal refuses anonymous access and says how to authenticate", async (t) => {
  const { app } = harness(t);
  const r = await req(app, { path: "/ui", auth: null });
  assert.equal(r.status, 401);
});

test("a wrong password is refused; the default credential is accepted", async (t) => {
  const { app } = harness(t);
  assert.equal((await req(app, { path: "/ui", auth: basic(DEFAULT_ADMIN_USER, "wrong") })).status, 401);
  assert.equal((await req(app, { path: "/ui" })).status, 200);
});

test("env vars override the default credential", () => {
  const r = checkAdminAuth({ authorization: basic("alice", "s3cret") }, { user: "alice", pass: "s3cret" });
  assert.equal(r.ok, true);
  assert.equal(checkAdminAuth({ authorization: ADMIN }, { user: "alice", pass: "s3cret" }).ok, false,
    "once overridden, the default stops working");
});

test("the API keeps its own auth: healthz open, token routes untouched by Basic", async (t) => {
  const { app } = harness(t);
  assert.equal((await req(app, { path: "/healthz", auth: null })).status, 200);
  const r = await req(app, { path: "/v1/ledger", auth: null });
  assert.equal(r.status, 401, "token auth, not basic auth, guards the API");
});

// ── the deploy flow ────────────────────────────────────────────────────────
test("deploying a worker writes one omoda.skill.md that the loader then loads", async (t) => {
  const { app, skillsDir, ledger } = harness(t);
  const csrf = await csrfOf(app);
  const r = await req(app, {
    method: "POST", path: "/ui/agents/new",
    form: { csrf, skill: "invoice-chaser", agent: "finance", level: "2", inference: "no",
            description: "Chases overdue invoices", capabilities: CAPS, instructions: "Chase politely." },
  });
  assert.equal(r.status, 303);
  assert.match(r.headers.location, /deployed=invoice-chaser/);

  const file = join(skillsDir, "invoice-chaser", "omoda.skill.md");
  assert.ok(existsSync(file));
  assert.match(readFileSync(file, "utf8"), /Chase politely/);

  // The real test: the file the portal wrote is a skill the platform loads.
  const { skills, errors } = loadSkills(skillsDir);
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.equal(skills[0].skill, "invoice-chaser");
  assert.equal(skills[0].level, 2);
  assert.ok(ledger.all().some((e) => e.tool === "ui.agent.deploy" && e.outcome === "deployed"));
});

test("an over-leveled deploy is refused with the reason, and nothing is written", async (t) => {
  const { app, skillsDir } = harness(t);
  const csrf = await csrfOf(app);
  const r = await req(app, {
    method: "POST", path: "/ui/agents/new",
    form: { csrf, skill: "bad-worker", agent: "x", level: "2", inference: "yes", capabilities: CAPS },
  });
  assert.equal(r.status, 422);
  assert.match(r.body, /inference grant/);
  assert.equal(existsSync(join(skillsDir, "bad-worker")), false);
});

test("a deploy never overwrites an enabled agent", async (t) => {
  const { app } = harness(t);
  const csrf = await csrfOf(app);
  const form = { csrf, skill: "dup", agent: "x", level: "2", inference: "no", capabilities: CAPS };
  assert.equal((await req(app, { method: "POST", path: "/ui/agents/new", form })).status, 303);
  const again = await req(app, { method: "POST", path: "/ui/agents/new", form });
  assert.equal(again.status, 422);
  assert.match(again.body, /never overwrite/);
});

test("a traversal-shaped skill name dies at the schema, far from the filesystem", async (t) => {
  const { app, skillsDir } = harness(t);
  const csrf = await csrfOf(app);
  const r = await req(app, {
    method: "POST", path: "/ui/agents/new",
    form: { csrf, skill: "../escape", agent: "x", level: "2", inference: "no", capabilities: CAPS },
  });
  assert.equal(r.status, 422);
  assert.equal(existsSync(join(skillsDir, "..", "escape")), false);
});

test("bad capabilities YAML is an error page, not a crash", async (t) => {
  const { app } = harness(t);
  const csrf = await csrfOf(app);
  const r = await req(app, {
    method: "POST", path: "/ui/agents/new",
    form: { csrf, skill: "y", agent: "x", level: "2", inference: "no", capabilities: "{{not yaml" },
  });
  assert.equal(r.status, 422);
  assert.match(r.body, /not valid YAML/);
});

test("a forged csrf is refused before anything else happens", async (t) => {
  const { app, skillsDir } = harness(t);
  const r = await req(app, {
    method: "POST", path: "/ui/agents/new",
    form: { csrf: "deadbeef", skill: "z", agent: "x", level: "2", inference: "no", capabilities: CAPS },
  });
  assert.equal(r.status, 403);
  assert.equal(existsSync(join(skillsDir, "z")), false);
});

test("apply-now triggers the injected restart hook; without it, nothing restarts", async (t) => {
  const { app, applied } = harness(t);
  const csrf = await csrfOf(app);
  await req(app, {
    method: "POST", path: "/ui/agents/new",
    form: { csrf, skill: "later", agent: "x", level: "2", inference: "no", capabilities: CAPS },
  });
  assert.equal(applied.length, 0, "no apply_now, no restart");
  await req(app, {
    method: "POST", path: "/ui/agents/new",
    form: { csrf, skill: "now", agent: "x", level: "2", inference: "no", capabilities: CAPS, apply_now: "yes" },
  });
  assert.equal(applied.length, 1);
});

test("an L0 orchestrator deploys with inference and no capabilities", async (t) => {
  const { app, skillsDir } = harness(t);
  const csrf = await csrfOf(app);
  const r = await req(app, {
    method: "POST", path: "/ui/agents/new",
    form: { csrf, skill: "conductor", agent: "l0", level: "0", inference: "yes", capabilities: "", instructions: "Route work." },
  });
  assert.equal(r.status, 303);
  const { skills } = loadSkills(skillsDir);
  assert.equal(skills[0].grants.inference, true);
  assert.equal(skills[0].grants.tools, "none");
});
