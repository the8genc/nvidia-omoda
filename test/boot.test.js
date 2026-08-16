import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { boot } from "../src/boot.js";

// The unit suite exercises every module and still missed a boot-order bug
// (knowledge referenced before initialization), because nothing here ever
// called boot(). The device smoke caught it; this makes the laptop catch it
// first. Boot the real thing, assert the pieces exist, close it.
test("boot() brings the whole platform up and back down", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omoda-boot-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const saved = { ...process.env };
  t.after(() => { process.env = saved; });
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.OMODA_STREAM_CONNECT;
  process.env.OMODA_LEDGER = join(dir, "ledger.jsonl");
  process.env.OMODA_KNOWLEDGE = join(dir, "knowledge");
  process.env.OMODA_EMBED_ENDPOINT = "http://127.0.0.1:9/v1/embeddings"; // down on purpose

  const sys = await boot({ port: 3157, streamPort: 3158, print: false, sandbox: null });
  try {
    assert.ok(sys.index.size >= 16, "skills compiled");
    assert.ok(sys.knowledge, "knowledge store exists");
    assert.match(sys.knowledge.backend, /lexical/, "embed server down = labeled lexical, not a crash");
    assert.equal(sys.telegram, null, "no token, no loop");

    const res = await fetch("http://127.0.0.1:3157/healthz");
    assert.equal(res.status, 200);
    const ui = await fetch("http://127.0.0.1:3157/ui");
    assert.equal(ui.status, 401, "portal locked");
  } finally {
    await sys.close();
  }
});
