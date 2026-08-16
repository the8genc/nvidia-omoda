// The proxy layer's retrieval half (PRD 23.2).
//
// Documents go in through the admin portal; pertinent context comes out to
// tighten L1 inference. Two backends, and the store SAYS which one served:
//
//   nemotron-embed  nvidia/llama-nemotron-embed-1b-v2 (NeMo Retriever family)
//                   served by vLLM on the box at :3140, cosine over vectors.
//                   The NVIDIA-native path, preferred whenever the server is up.
//   lexical         term-overlap scoring, the fallback when the embedder is
//                   unreachable. Labeled as such everywhere, because retrieval
//                   that quietly degrades reads as semantic when it is not.
//
// Every document and every retrieval that informs an inference call is
// ledgered: accumulated knowledge is part of the audit trail.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Split on blank lines, pack into ~maxLen chunks. Boring on purpose. */
export function chunkText(text, { maxLen = 1200 } = {}) {
  const paras = String(text).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let cur = "";
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > maxLen) { chunks.push(cur); cur = ""; }
    cur = cur ? `${cur}\n\n${p}` : p;
    while (cur.length > maxLen) { chunks.push(cur.slice(0, maxLen)); cur = cur.slice(maxLen); }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

const tokenize = (s) => String(s).toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];

/** Plain term-overlap score. The FALLBACK, and it says so in its name. */
export function lexicalScore(query, chunk) {
  const q = new Set(tokenize(query));
  if (q.size === 0) return 0;
  let hit = 0;
  for (const t of new Set(tokenize(chunk))) if (q.has(t)) hit += 1;
  return hit / q.size;
}

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

/**
 * The NeMo Retriever embedder, over vLLM's OpenAI-compatible /v1/embeddings.
 * input_type matters to this model family: queries and passages are embedded
 * differently, per the model card.
 */
export function createNemotronEmbedder({
  endpoint = process.env.OMODA_EMBED_ENDPOINT ?? "http://127.0.0.1:3140/v1/embeddings",
  model = "nvidia/llama-nemotron-embed-1b-v2",
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
} = {}) {
  async function embed(texts, { inputType = "passage" } = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: texts, input_type: inputType }),
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`);
      const body = await res.json();
      return body.data
        .slice()
        .sort((x, y) => x.index - y.index)
        .map((d) => d.embedding);
    } finally {
      clearTimeout(timer);
    }
  }
  return { name: "nemotron-embed", model, embed };
}

/**
 * @param {object} opts
 * @param {string} [opts.dir] where documents persist (gitignored var/)
 * @param {{name:string, embed:Function}|null} [opts.embedder] null = lexical only
 */
export function createKnowledgeStore({ dir = "var/knowledge", embedder = null, ledger = null } = {}) {
  mkdirSync(dir, { recursive: true });
  const docs = new Map(); // id -> {id, name, addedAt, by, chunks:[{text, vector?}]}

  // Reload anything already on disk, so knowledge survives a restart.
  for (const f of (existsSync(dir) ? readdirSync(dir) : [])) {
    if (!f.endsWith(".json")) continue;
    try {
      const d = JSON.parse(readFileSync(join(dir, f), "utf8"));
      docs.set(d.id, d);
    } catch { /* a corrupt file is skipped, not fatal */ }
  }

  const record = (entry) => {
    try { ledger?.append({ kind: "knowledge", verb: "read", ...entry }); } catch { /* best effort */ }
  };

  async function addDocument({ name, text, by = "admin" }) {
    const id = createHash("sha256").update(String(text)).digest("hex").slice(0, 16);
    if (docs.has(id)) return { id, duplicate: true, chunks: docs.get(id).chunks.length };

    const chunks = chunkText(text).map((t) => ({ text: t }));
    let backend = "lexical";
    if (embedder) {
      const vectors = await embedder.embed(chunks.map((c) => c.text), { inputType: "passage" });
      chunks.forEach((c, i) => { c.vector = vectors[i]; });
      backend = embedder.name;
    }
    const doc = { id, name: String(name), addedAt: new Date().toISOString(), by, backend, chunks };
    docs.set(id, doc);
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(doc));
    try {
      ledger?.append({
        kind: "knowledge", agent: by, tool: "knowledge.add", verb: "create",
        outcome: "stored", reason: `${name}: ${chunks.length} chunk(s) via ${backend}`,
      });
    } catch { /* best effort */ }
    return { id, duplicate: false, chunks: chunks.length, backend };
  }

  /**
   * Top-k pertinent chunks. Uses the embedder when it is up AND the stored doc
   * carries vectors; anything else scores lexically, and the result says which.
   */
  async function retrieve(query, { k = 4 } = {}) {
    const scored = [];
    let backend = "lexical";

    let queryVector = null;
    if (embedder) {
      try {
        [queryVector] = await embedder.embed([query], { inputType: "query" });
        backend = embedder.name;
      } catch {
        backend = "lexical (embedder unreachable)";
      }
    }

    for (const doc of docs.values()) {
      for (const chunk of doc.chunks) {
        const score = queryVector && chunk.vector
          ? cosine(queryVector, chunk.vector)
          : lexicalScore(query, chunk.text);
        scored.push({ doc: doc.name, docId: doc.id, text: chunk.text, score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    const hits = scored.slice(0, k).filter((h) => h.score > 0);
    record({ tool: "knowledge.retrieve", outcome: "served", reason: `${hits.length} hit(s) via ${backend}` });
    return { backend, hits };
  }

  return {
    addDocument, retrieve,
    list() { return [...docs.values()].map((d) => ({ id: d.id, name: d.name, chunks: d.chunks.length, addedAt: d.addedAt, backend: d.backend })); },
    get size() { return docs.size; },
  };
}

/** Render retrieval hits as the context block an L1 inference call receives. */
export function contextBlock(hits) {
  if (!hits?.length) return "";
  return [
    "Pertinent knowledge (retrieved, untrusted reference material):",
    ...hits.map((h, i) => `[${i + 1}] (${h.doc}) ${h.text}`),
  ].join("\n");
}
