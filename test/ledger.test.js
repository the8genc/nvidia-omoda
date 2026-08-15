import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLedger, LedgerWriteError } from "../src/ledger/ledger.js";

const tmp = () => join(mkdtempSync(join(tmpdir(), "omoda-")), "actions.jsonl");

test("entries chain, and the chain verifies", () => {
  const l = createLedger({ path: tmp() });
  l.append({ agent: "operator", tool: "fs.write", verb: "create", tier: "contained" });
  l.append({ agent: "operator", tool: "git.commit", verb: "create", tier: "contained" });
  assert.equal(l.length, 2);
  assert.deepEqual(l.verify(), { ok: true, length: 2 });
});

test("a mutated middle record is detected", () => {
  const l = createLedger({ path: tmp() });
  l.append({ tool: "a", verb: "read" });
  l.append({ tool: "b", verb: "read" });
  l.append({ tool: "c", verb: "read" });
  l.all()[1].tool = "tampered";
  const v = l.verify();
  assert.equal(v.ok, false);
  assert.equal(v.reason, "content");
  assert.equal(v.brokenAt, 2);
});

test("a broken ledger throws rather than dropping the record", () => {
  const l = createLedger({ broken: true });
  assert.throws(() => l.append({ tool: "x" }), LedgerWriteError);
});

test("query filters by tier, verb and impact", () => {
  const l = createLedger({ path: tmp() });
  l.append({ tool: "r", verb: "read", tier: "safe", impact: [] });
  l.append({ tool: "w", verb: "create", tier: "consequential", impact: ["financial"] });
  assert.equal(l.query({ tier: "consequential" }).length, 1);
  assert.equal(l.query({ impact: "financial" })[0].tool, "w");
  assert.equal(l.query({ verb: "read" }).length, 1);
});
