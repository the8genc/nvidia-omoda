import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { compileOpenShellFragment } from "../src/policy/compile.js";
import { createEnvelope, pathMatches } from "../src/policy/envelope.js";

const manifest = parse(
  readFileSync(new URL("./fixtures/invoice-dispatch.yaml", import.meta.url), "utf8"),
);
const env = () => createEnvelope(compileOpenShellFragment(manifest));
const QB = "quickbooks.api.intuit.com";

test("glob matching handles both depths of wildcard", () => {
  assert.equal(pathMatches("/v3/company/**", "/v3/company/123/invoice"), true);
  assert.equal(pathMatches("/bot*/sendMessage", "/bot123:ABC/sendMessage"), true);
  assert.equal(pathMatches("/bot*/sendMessage", "/bot123/x/sendMessage"), false);
  assert.equal(pathMatches("/v3/company/**", "/v4/company/1"), false);
});

test("THE DEMO: a financial POST is 403 because the method is absent", () => {
  const r = env().check({ host: QB, method: "POST", path: "/v3/company/1/invoice" });
  assert.equal(r.allowed, false);
  assert.equal(r.status, 403);
  assert.match(r.reason, /capability is absent/);
});

test("the corresponding GET is allowed, so this is not a blanket block", () => {
  const r = env().check({ host: QB, method: "GET", path: "/v3/company/1/invoice" });
  assert.equal(r.allowed, true);
});

test("an undeclared host has no entry at all", () => {
  const r = env().check({ host: "evil.example", method: "GET", path: "/" });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /no policy entry/);
});

test("a delta opens exactly one method, then closes it completely", () => {
  const e = env();
  const req = { host: QB, method: "POST", path: "/v3/company/1/invoice" };
  assert.equal(e.check(req).allowed, false);

  e.applyDelta({ id: "d1", host: QB, method: "POST", path: "/v3/company/**/invoice" });
  assert.equal(e.check(req).allowed, true, "the decision materialized the capability");
  assert.equal(
    e.check({ ...req, path: "/v3/company/1/payment" }).allowed,
    false,
    "and only that capability: a sibling path stays closed",
  );

  e.revertDelta({ id: "d1" });
  assert.equal(e.check(req).allowed, false, "the capability is gone again");
  assert.deepEqual(e.openDeltas, []);
});

test("reverting one delta does not remove another", () => {
  const e = env();
  e.applyDelta({ id: "d1", host: QB, method: "POST", path: "/a" });
  e.applyDelta({ id: "d2", host: QB, method: "PUT", path: "/b" });
  e.revertDelta({ id: "d1" });
  assert.equal(e.check({ host: QB, method: "PUT", path: "/b" }).allowed, true);
  assert.deepEqual(e.openDeltas, ["d2"]);
});

test("a non-rest entry is an unfiltered L4 tunnel, and we say so", () => {
  const e = createEnvelope({
    network_policies: {
      ws: { name: "ws", endpoints: [{ host: "feed.local", port: 443, protocol: "raw", rules: [] }] },
    },
  });
  const r = e.check({ host: "feed.local", method: "POST", path: "/anything" });
  assert.equal(r.allowed, true);
  assert.match(r.reason, /L4 tunnel, unfiltered/);
});
