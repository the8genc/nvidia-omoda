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
import { createTriggerStore } from "../src/transport/triggers.js";
const mkTriggers = () => createTriggerStore({ path: join(mkdtempSync(join(tmpdir(), "omoda-t-")), "t.json") });

const basic = (u, p) => "Basic " + Buffer.from(`${u}:${p}`).toString("base64");
const ADMIN = basic(DEFAULT_ADMIN_USER, DEFAULT_ADMIN_PASS);

function harness(t) {
  const skillsDir = mkdtempSync(join(tmpdir(), "omoda-deploy-"));
  t.after(() => rmSync(skillsDir, { recursive: true, force: true }));
  const applied = [];
  const ledger = createLedger({ path: `/tmp/omoda-portal-${Date.now()}-${Math.random()}.jsonl` });
  const triggers = mkTriggers();
  const app = createApp({
    tokens: createTokenStore(), ledger, intents: createIntentStore(),
    skillsDir, onApply: () => applied.push(true),
    uiOperator: { id: "operator:arif", scopes: ["intent:decide"] },
    triggers, l1Agents: ["accident", "fire"],
  });
  return { app, skillsDir, applied, ledger, triggers };
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

test("the triggers page lists rules and requires the admin credential", async (t) => {
  const { app } = harness(t);
  assert.equal((await req(app, { path: "/ui/triggers", auth: null })).status, 401);
  const r = await req(app, { path: "/ui/triggers" });
  assert.equal(r.status, 200);
  assert.match(r.body, /take-action trigger/i);
});

test("an admin can add a trigger through the portal", async (t) => {
  const { app, triggers } = harness(t);
  const csrf = (await req(app, { path: "/ui/triggers" })).body.match(/name="csrf" value="([a-f0-9]+)"/)[1];
  const before = triggers.size;
  const r = await req(app, { method: "POST", path: "/ui/triggers", form: { csrf, phrases: "rollover, overturned", incidentType: "traffic-accident", l1: "accident", action: "handle it" } });
  assert.equal(r.status, 200);
  assert.equal(triggers.size, before + 1);
  assert.equal(triggers.match("an overturned car").rule.l1, "accident");
});

test("a forged csrf cannot edit triggers", async (t) => {
  const { app, triggers } = harness(t);
  const before = triggers.size;
  const r = await req(app, { method: "POST", path: "/ui/triggers", form: { csrf: "bad", phrases: "x", l1: "accident" } });
  assert.equal(r.status, 403);
  assert.equal(triggers.size, before);
});

test("the audit page is admin-gated and shows the robust record with the chain state", async (t) => {
  const { app, ledger } = harness(t);
  // seed a couple of ledgered actions with the robust linkage fields
  ledger.append({ kind: "orchestrator", agent: "l0", tool: "l0.review", verb: "read", outcome: "routed-to-l1", reason: "traffic-accident -> accident", intentId: "int-7", triggerPhrase: "collision" });
  ledger.append({ agent: "emergency-dispatch", tool: "dispatch.unit.request", verb: "create", impact: ["legal"], tier: "consequential", authority: "decision:d-1", decidedBy: "arif", outcome: "executed", intentId: "int-7", target: "POST 100.71.143.26/api/dispatch" });

  // no auth -> 401
  const noauth = await req(app, { path: "/ui/audit", auth: null });
  assert.equal(noauth.status, 401);

  // admin -> the full record is present, not just the condensed fields
  const page = await req(app, { path: "/ui/audit" });
  assert.equal(page.status, 200);
  assert.match(page.body, /Audit trail/);
  assert.match(page.body, /chain verifies/);
  assert.match(page.body, /emergency-dispatch/);
  assert.match(page.body, /int-7/, "the incident id links the chain");
  assert.match(page.body, /collision/, "the trigger word is recorded");
  assert.match(page.body, /arif/, "who approved is recorded");
  assert.match(page.body, /api\/dispatch/, "the concrete target call is recorded");
  assert.match(page.body, /raw/, "the raw hash-chained record is available per row");

  // a filter narrows the query (intent that does not exist -> empty)
  const empty = await req(app, { path: "/ui/audit?intent=nope" });
  assert.match(empty.body, /No matching audit records/);
});
