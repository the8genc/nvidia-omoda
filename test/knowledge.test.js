import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  chunkText, lexicalScore, cosine, createKnowledgeStore, createNemotronEmbedder, contextBlock,
} from "../src/knowledge/store.js";
import { createLedger } from "../src/ledger/ledger.js";

const tmp = (t) => {
  const d = mkdtempSync(join(tmpdir(), "omoda-know-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
};
const ledger = () => createLedger({ path: `/tmp/omoda-know-${Date.now()}-${Math.random()}.jsonl` });

// A fake NeMo Retriever endpoint: "embeds" by keyword so cosine ranking is testable.
function fakeEmbedder() {
  const calls = [];
  const vec = (s) => {
    const t = String(s).toLowerCase();
    return [t.includes("invoice") ? 1 : 0, t.includes("cake") ? 1 : 0, t.includes("lane") ? 1 : 0, 0.01];
  };
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    return {
      ok: true, status: 200,
      async json() { return { data: body.input.map((s, index) => ({ index, embedding: vec(s) })) }; },
    };
  };
  return { embedder: createNemotronEmbedder({ endpoint: "http://embed.test/v1/embeddings", fetchImpl }), calls };
}

test("chunking packs paragraphs and never returns an oversized chunk", () => {
  const text = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} ${"x".repeat(200)}`).join("\n\n");
  const chunks = chunkText(text, { maxLen: 500 });
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 500);
});

test("lexical scoring is the honest fallback: overlap over query terms", () => {
  assert.ok(lexicalScore("incident invoice", "raise the incident callout invoice") > 0.9);
  assert.equal(lexicalScore("incident invoice", "a recipe for lemon cake"), 0);
});

test("the embedder sends input_type per the model card: passage for docs, query for queries", async (t) => {
  const { embedder, calls } = fakeEmbedder();
  const store = createKnowledgeStore({ dir: tmp(t), embedder, ledger: ledger() });
  await store.addDocument({ name: "runbook", text: "The invoice runbook for the blocked lane." });
  await store.retrieve("raise the invoice");
  assert.equal(calls[0].input_type, "passage");
  assert.equal(calls[1].input_type, "query");
  assert.equal(calls[0].model, "nvidia/llama-nemotron-embed-1b-v2");
});

test("retrieval ranks by cosine when embedded, and says which backend served", async (t) => {
  const { embedder } = fakeEmbedder();
  const store = createKnowledgeStore({ dir: tmp(t), embedder, ledger: ledger() });
  await store.addDocument({ name: "runbook", text: "How to raise the incident invoice.\n\nA recipe for lemon cake." });
  const r = await store.retrieve("invoice for the lane", { k: 1 });
  assert.equal(r.backend, "nemotron-embed");
  assert.match(r.hits[0].text, /invoice/);
});

test("with the embedder unreachable, retrieval degrades to lexical AND LABELS IT", async (t) => {
  const embedder = createNemotronEmbedder({
    endpoint: "http://embed.test/v1/embeddings",
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
  });
  const dir = tmp(t);
  // Stored earlier without vectors (lexical store), then queried with a dead embedder.
  const store = createKnowledgeStore({ dir, embedder: null, ledger: ledger() });
  await store.addDocument({ name: "runbook", text: "How to raise the incident invoice." });
  const store2 = createKnowledgeStore({ dir, embedder, ledger: ledger() });
  const r = await store2.retrieve("incident invoice");
  assert.match(r.backend, /lexical \(embedder unreachable\)/);
  assert.ok(r.hits.length > 0, "the answer still comes, honestly labeled");
});

test("documents survive a restart: a new store over the same dir reloads them", async (t) => {
  const dir = tmp(t);
  const a = createKnowledgeStore({ dir, ledger: ledger() });
  await a.addDocument({ name: "persists", text: "Knowledge is part of the audit trail." });
  const b = createKnowledgeStore({ dir, ledger: ledger() });
  assert.equal(b.size, 1);
  assert.equal(b.list()[0].name, "persists");
});

test("the same content is deduplicated by hash, not stored twice", async (t) => {
  const store = createKnowledgeStore({ dir: tmp(t), ledger: ledger() });
  const first = await store.addDocument({ name: "a", text: "same text" });
  const again = await store.addDocument({ name: "b", text: "same text" });
  assert.equal(first.duplicate, false);
  assert.equal(again.duplicate, true);
  assert.equal(store.size, 1);
});

test("adding and retrieving are ledgered: accumulated knowledge is audit-trail material", async (t) => {
  const led = ledger();
  const store = createKnowledgeStore({ dir: tmp(t), ledger: led });
  await store.addDocument({ name: "r", text: "the runbook" });
  await store.retrieve("runbook");
  const tools = led.all().map((e) => e.tool);
  assert.ok(tools.includes("knowledge.add"));
  assert.ok(tools.includes("knowledge.retrieve"));
});

test("contextBlock renders hits as clearly untrusted reference material", () => {
  const block = contextBlock([{ doc: "runbook", text: "step one" }]);
  assert.match(block, /untrusted reference material/);
  assert.match(block, /\[1\] \(runbook\) step one/);
  assert.equal(contextBlock([]), "");
});

test("cosine is sane", () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
});
