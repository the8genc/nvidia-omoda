import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { safeParseManifest } from "../src/schema/manifest.js";
import { loadSkills, grantsFor, parseSkillMarkdown } from "../src/skills/load.js";

const cap = (over = {}) => ({ tool: "x.read", verb: "read", impact: [], ...over });
const base = { skill: "t", agent: "t", capabilities: [cap()] };

// ── the level contract, refused at compile time ───────────────────────────
test("a manifest without a level defaults to 2, preserving every existing skill", () => {
  const r = safeParseManifest(base);
  assert.equal(r.success, true);
  assert.equal(r.data.level, 2);
  assert.equal(r.data.inference, false);
});

test("an L2 holding an inference grant is refused: no client to be talked into calling", () => {
  const r = safeParseManifest({ ...base, level: 2, inference: true });
  assert.equal(r.success, false);
  assert.match(r.error.issues[0].message, /may not hold an inference grant/);
});

test("an L1 declaring capabilities is refused: experts direct, they do not execute", () => {
  const r = safeParseManifest({ ...base, level: 1 });
  assert.equal(r.success, false);
  assert.match(r.error.issues[0].message, /do not execute tools/);
});

test("an L3 with a local (no-egress) capability is refused: pure connectivity only", () => {
  const r = safeParseManifest({ ...base, level: 3 });
  assert.equal(r.success, false);
  assert.match(r.error.issues[0].message, /no egress/);
});

test("an L3 declaring filesystem writes is refused", () => {
  const r = safeParseManifest({
    skill: "t", agent: "t", level: 3,
    capabilities: [cap({ egress: { host: "api.example.com" } })],
    filesystem: { read: [], write: ["/tmp/x"] },
  });
  assert.equal(r.success, false);
  assert.match(r.error.issues[0].message, /filesystem writes/);
});

test("an L0 orchestrator compiles: inference, no tools", () => {
  const r = safeParseManifest({ skill: "orchestrator", agent: "l0", level: 0, inference: true, capabilities: [] });
  assert.equal(r.success, true);
});

test("a worker with no tools at all is refused: it would do nothing", () => {
  const r = safeParseManifest({ skill: "t", agent: "t", level: 2, capabilities: [] });
  assert.equal(r.success, false);
  assert.match(r.error.issues[0].message, /no capabilities/);
});

// ── injection by level ────────────────────────────────────────────────────
test("grants are injected by level, so authority is structural", () => {
  assert.deepEqual({ ...grantsFor(0) }, { level: 0, inference: true, retrieval: false, tools: "none", taskContext: true });
  assert.deepEqual({ ...grantsFor(1) }, { level: 1, inference: true, retrieval: true, tools: "none", taskContext: true });
  assert.deepEqual({ ...grantsFor(2) }, { level: 2, inference: false, retrieval: false, tools: "consent-none", taskContext: true });
  assert.deepEqual({ ...grantsFor(3) }, { level: 3, inference: false, retrieval: false, tools: "all-declared", taskContext: false });
});

test("an L3 is never granted task context; an L2 is never granted inference", () => {
  assert.equal(grantsFor(3).taskContext, false);
  assert.equal(grantsFor(2).inference, false);
});

// ── omoda.skill.md, the v4 single-file shape ──────────────────────────────
const MD = `---
skill: md-worker
agent: worker
level: 2
capabilities:
  - tool: api.read
    verb: read
    impact: []
    egress: { host: api.example.com }
---
Read the thing, write nothing, escalate to your L1 when unsure.
`;

test("parseSkillMarkdown splits front matter from instructions", () => {
  const { manifest, instructions } = parseSkillMarkdown(MD);
  assert.equal(manifest.skill, "md-worker");
  assert.equal(manifest.level, 2);
  assert.match(instructions, /escalate to your L1/);
});

test("a file without front matter is an error, not a guess", () => {
  assert.throws(() => parseSkillMarkdown("just some prose"), /front matter/);
});

test("loadSkills loads .skill.md, carries level, grants and instructions", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omoda-skills-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "md-worker"));
  writeFileSync(join(dir, "md-worker", "omoda.skill.md"), MD);

  const { skills, errors } = loadSkills(dir);
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.equal(skills.length, 1);
  assert.equal(skills[0].level, 2);
  assert.equal(skills[0].grants.inference, false);
  assert.match(skills[0].instructions, /escalate/);
});

test("an over-leveled .skill.md fails to load, and the platform refuses to half-boot on it", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omoda-skills-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "bad"));
  writeFileSync(join(dir, "bad", "omoda.skill.md"), MD.replace("level: 2", "level: 2\ninference: true"));

  const { skills, errors } = loadSkills(dir);
  assert.equal(skills.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /inference grant/);
});

test("when both .md and .yaml exist, the md wins", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omoda-skills-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "dual"));
  writeFileSync(join(dir, "dual", "omoda.skill.md"), MD);
  writeFileSync(join(dir, "dual", "omoda.skill.yaml"), "skill: yaml-version\nagent: worker\ncapabilities:\n  - { tool: y.read, verb: read, impact: [] }\n");

  const { skills } = loadSkills(dir);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].skill, "md-worker");
});
