import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import {
  compile, compileOpenShellFragment, compileConsentPlan, compileRegistry, fragmentToYaml,
} from "../src/policy/compile.js";

const manifest = parse(readFileSync(new URL("./fixtures/invoice-dispatch.yaml", import.meta.url), "utf8"));

function rulesFor(frag) {
  const key = Object.keys(frag.network_policies)[0];
  return frag.network_policies[key].endpoints[0].rules.map((r) => `${r.allow.method} ${r.allow.path}`);
}

test("THE THESIS: a write carrying impact compiles to read-only", () => {
  const rules = rulesFor(compileOpenShellFragment(manifest));
  // invoice.create is financial. POST must NOT appear anywhere.
  assert.ok(!rules.some((r) => r.startsWith("POST")), `no POST granted, got ${JSON.stringify(rules)}`);
  assert.ok(!rules.some((r) => r.startsWith("DELETE")), "no DELETE granted for a financial+legal void");
  assert.ok(rules.every((r) => r.startsWith("GET")), "only GET survives compilation");
});

test("the endpoint carries protocol rest and enforce, or the rules are decorative", () => {
  const frag = compileOpenShellFragment(manifest);
  const ep = frag.network_policies[Object.keys(frag.network_policies)[0]].endpoints[0];
  assert.equal(ep.protocol, "rest");
  assert.equal(ep.enforcement, "enforce");
  assert.equal(ep.port, 443);
});

test("a contained write DOES get its real method", () => {
  const frag = compileOpenShellFragment({
    skill: "notes", agent: "builder",
    capabilities: [{ tool: "notes.add", verb: "create", impact: [], egress: { host: "notes.local", path: "/n" } }],
  });
  assert.deepEqual(rulesFor(frag), ["POST /n"]);
});

test("binaries are scoped, and filesystem grants are emitted", () => {
  const frag = compileOpenShellFragment(manifest);
  const np = frag.network_policies[Object.keys(frag.network_policies)[0]];
  assert.deepEqual(np.binaries, [
    { path: "/opt/hermes/.venv/bin/python" }, { path: "/usr/local/bin/node" },
  ]);
  assert.deepEqual(frag.filesystem_policy.read_only, ["/workspace"]);
  assert.deepEqual(frag.filesystem_policy.read_write, ["/workspace/out"]);
});

test("local-only tools produce no egress entry", () => {
  const frag = compileOpenShellFragment({
    skill: "local", agent: "operator",
    capabilities: [{ tool: "fs.write", verb: "update", impact: [] }],
    filesystem: { read: ["/workspace"], write: ["/workspace"] },
  });
  assert.equal(frag.network_policies, undefined, "no egress declared means no egress granted");
});

test("consent plan escalates by severity and destructiveness", () => {
  const plan = compileConsentPlan(manifest);
  const byTool = Object.fromEntries(plan.map((p) => [p.tool, p]));
  assert.equal(plan.length, 2, "only the two impactful writes need consent");
  assert.equal(byTool["quickbooks.invoice.create"].stage, "approval");
  assert.equal(byTool["quickbooks.invoice.void"].stage, "two-person");
  assert.equal(byTool["quickbooks.invoice.void"].inverseRequired, true);
  assert.ok(!byTool["quickbooks.invoice.read"], "reads never need consent");
  assert.ok(!byTool["fs.write"], "a contained write needs no consent");
});

test("registry renders the human-readable capability table", () => {
  const rows = compileRegistry(manifest);
  const create = rows.find((r) => r.tool === "quickbooks.invoice.create");
  assert.equal(create.agent, "finance");
  assert.equal(create.consent, "approval");
  assert.match(create.grant, /read-only until consented/);
  const read = rows.find((r) => r.tool === "quickbooks.invoice.read");
  assert.equal(read.consent, "none");
});

test("compilation is deterministic, so golden files mean something", () => {
  assert.equal(fragmentToYaml(compile(manifest).fragment), fragmentToYaml(compile(manifest).fragment));
});

test("an invalid manifest is rejected, not silently coerced", () => {
  assert.throws(() => compileOpenShellFragment({ skill: "x", agent: "y", capabilities: [] }), /capabilities/i);
  assert.throws(
    () => compileOpenShellFragment({ skill: "x", agent: "y", capabilities: [{ tool: "t", verb: "exfiltrate" }] }),
    /verb/i,
  );
});
