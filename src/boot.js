#!/usr/bin/env node
// Boot the platform: load skills, compile envelopes, issue identities, serve.
//
//   npm start
//
// Binds inside our 3100-3199 block and refuses anything else. Service tokens are
// printed ONCE here and never logged again; rotate before recording the demo.

import { loadSkills, buildCapabilityIndex, mergeFragments } from "./skills/load.js";
import { createApp } from "./api/server.js";
import { createTokenStore, createNonceCache, createRateLimiter, assertBindable, SCOPES } from "./api/auth.js";
import { createIntentStore } from "./api/intents.js";
import { createLedger } from "./ledger/ledger.js";
import { createStreamIngest, attachStreamServer, createUpstreamDialer } from "./api/stream.js";
import { createSimulatedPolicy } from "./policy/envelope.js";
import { createOpenShellPolicy } from "./policy/openshell.js";
import { fragmentToYaml } from "./policy/compile.js";
import { createTelegramClient, createHttpTransport } from "./channels/telegram.js";
import { createTelegramLoop } from "./channels/telegram-loop.js";
import { createModalityTransform } from "./channels/modality.js";
import { createInferenceClient } from "./models/client.js";
import { createKnowledgeStore, createNemotronEmbedder } from "./knowledge/store.js";
import { readFileSync, existsSync } from "node:fs";

/** Minimal .env reader. Avoids depending on a --env-file flag being available. */
function loadEnvFile(path = ".env") {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (process.env[k] === undefined) process.env[k] = v.trim();
  }
}
loadEnvFile();

const PORT = Number(process.env.OMODA_PORT ?? 3110);
const STREAM_PORT = Number(process.env.OMODA_STREAM_PORT ?? 3111);
const HOST = process.env.OMODA_HOST ?? "127.0.0.1";
const SANDBOX = process.env.OMODA_SANDBOX ?? null;

async function execCli(cmd, args, input) {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const p = spawn(cmd, args);
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    p.on("error", (err) => resolve({ code: 1, stdout: "", stderr: err.message }));
    if (input) { p.stdin.write(input); p.stdin.end(); }
  });
}

export async function boot({ port = PORT, streamPort = STREAM_PORT, host = HOST, sandbox = SANDBOX, print = true } = {}) {
  assertBindable(port, host);
  assertBindable(streamPort, host);

  const { skills, errors } = loadSkills();
  if (errors.length) {
    // A skill that does not compile must not appear to be enabled.
    for (const e of errors) console.error(`skill failed to compile: ${e.path}: ${e.error}`);
    throw new Error(`${errors.length} skill manifest(s) failed to compile; refusing to boot half-configured`);
  }

  const index = buildCapabilityIndex(skills);
  const merged = mergeFragments(skills);

  // On the box we drive the real CLIs. Off the box we evaluate the same
  // compiled fragment in process, so behaviour is identical either way.
  const policy = sandbox
    ? createOpenShellPolicy({ sandbox, exec: execCli })
    : createSimulatedPolicy(merged);

  const tokens = createTokenStore();
  const operator = tokens.issue({
    id: "operator:arif",
    scopes: [SCOPES.PROPOSE, SCOPES.READ, SCOPES.DECIDE, SCOPES.LEDGER, SCOPES.HALT],
  });
  // The See feed gets propose and nothing else. This is the keystone.
  const see = tokens.issue({ id: "see:leftovers", scopes: [SCOPES.PROPOSE] });

  const ledger = createLedger({ path: process.env.OMODA_LEDGER ?? "var/ledger/actions.jsonl" });
  // A deployment with a single operator identity cannot satisfy a two-person
  // rule; the store fails those closed rather than accept one tap. The operator
  // allowlist is the source of truth for how many distinct deciders exist.
  const operatorCount = (process.env.TELEGRAM_ALLOWED_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean).length;
  const intents = createIntentStore({ singleOperator: operatorCount <= 1 });

  const app = createApp({
    tokens, ledger, intents,
    nonces: createNonceCache(),
    limiter: createRateLimiter({ capacity: 120, refillPerSec: 2 }),
    skills: skills.map((s) => ({ skill: s.skill, agent: s.agent, registry: s.registry })),
    uiOperator: operator,
    knowledge,
  });

  // The proxy layer's retrieval store (PRD 23.2). NeMo Retriever embeddings
  // when the on-box embed server answers; lexical otherwise, labeled as such.
  const embedEndpoint = process.env.OMODA_EMBED_ENDPOINT ?? "http://127.0.0.1:3140/v1/embeddings";
  let embedder = null;
  try {
    const probe = await fetch(embedEndpoint.replace(/\/v1\/embeddings$/, "/health"), { signal: AbortSignal.timeout(2500) });
    if (probe.ok) embedder = createNemotronEmbedder({ endpoint: embedEndpoint });
  } catch { /* embed server down; the store labels itself lexical */ }
  const knowledge = createKnowledgeStore({
    dir: process.env.OMODA_KNOWLEDGE ?? "var/knowledge", embedder, ledger,
  });
  knowledge.backend = embedder ? embedder.name : "lexical (embed server down)";

  const ingest = createStreamIngest({ tokens, intents, ledger });
  await new Promise((r) => app.server.listen(port, host, r));

  const { createServer } = await import("node:http");
  const streamServer = createServer((_req, res) => { res.writeHead(426); res.end("upgrade required"); });
  await attachStreamServer({ server: streamServer, ingest });
  await new Promise((r) => streamServer.listen(streamPort, host, r));

  // Outbound client mode (PRD 23.1): dial a stream that is already pushing
  // JSON. Host service only; frames enter the same ingest path as inbound,
  // under a fresh propose-only identity.
  let upstream = null;
  const dialUrl = process.env.OMODA_STREAM_CONNECT;
  if (dialUrl) {
    const dialIdentity = tokens.issue({ id: `stream:dial`, scopes: [SCOPES.PROPOSE] });
    const { WebSocket } = await import("ws");
    upstream = createUpstreamDialer({
      url: dialUrl, ingest, identity: dialIdentity, WebSocketImpl: WebSocket,
      onLog: (m) => console.log(`  stream  ${m}`),
    });
    upstream.start();
  }

  // ── Telegram, only if configured, and only if it can fail closed ──────
  let telegram = null;
  let telegramClient = null;
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgIds = (process.env.TELEGRAM_ALLOWED_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (tgToken && tgIds.length === 0) {
    console.warn(
      "\n  TELEGRAM: token present but TELEGRAM_ALLOWED_IDS is empty.\n" +
      "  Refusing to start the operator loop: an empty allowlist trusts nobody,\n" +
      "  so the loop would accept a tap from anyone who finds the bot.\n" +
      "  Message the bot, then set the numeric id.\n",
    );
  } else if (tgToken) {
    const transport = createHttpTransport({ token: tgToken });
    telegramClient = createTelegramClient({ transport, allowedIds: tgIds });
    // The v4 voice door: a voice note is downloaded to the box and transcribed
    // by the LOCAL Omni; route() inside the transform is what guarantees the
    // audio never goes to a hosted endpoint.
    const mediaTransform = createModalityTransform({
      transport, token: tgToken, inference: createInferenceClient({ timeoutMs: 180_000 }),
    });
    telegram = createTelegramLoop({ client: telegramClient, intents, ledger, policy, operator, transport, mediaTransform });
    telegram.start().catch((err) => console.error(`telegram loop stopped: ${err.message}`));
  }

  if (print) {
    const line = (s) => console.log(s);
    line("");
    line("OMODA is up.");
    line(`  API     http://${host}:${port}`);
    line(`  UI      http://${host}:${port}/ui`);
    line(`  stream  ws://${host}:${streamPort}/v1/stream${dialUrl ? ` + dialing ${dialUrl}` : ""}`);
    line(`  policy  ${sandbox ? `openshell sandbox "${sandbox}"` : "in-process envelope (no sandbox configured)"}`);
    line(`  rag     ${knowledge.backend} (${knowledge.size} document(s))`);
    line(`  tg      ${telegram ? `live, operator ids [${tgIds.join(",")}], voice via local Omni` : tgToken ? "configured but IDLE (no allowlist)" : "not configured"}`);
    line("");
    line(`  skills  ${skills.map((s) => s.skill).join(", ") || "none"}`);
    line(`  tools   ${index.size} declared; anything else is denied`);
    const gated = index.all().filter((c) => c.consent !== "none");
    line(`  gated   ${gated.length} require a recorded decision: ${gated.map((c) => c.tool).join(", ")}`);
    const methods = new Set(
      Object.values(merged.network_policies ?? {})
        .flatMap((g) => g.endpoints.flatMap((e) => (e.rules ?? []).map((r) => r.allow.method))),
    );
    line(`  granted ${[...methods].join(", ") || "nothing"} across every enabled skill`);
    line("");
    line("  SERVICE TOKENS, printed once. Do not commit, do not screenshot.");
    line(`    operator  ${operator.token}`);
    line(`      secret  ${operator.secret}`);
    line(`    see       ${see.token}`);
    line(`      secret  ${see.secret}`);
    line("");
  }

  return { app, ingest, streamServer, tokens, ledger, intents, policy, skills, index, merged, operator, see, telegram, telegramClient, upstream, knowledge,
    async close() {
      telegram?.stop();
      upstream?.stop();
      await new Promise((r) => app.server.close(r));
      await new Promise((r) => streamServer.close(r));
    } };
}

// Also usable as: node src/boot.js --print-policy
if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--print-policy")) {
    const { skills } = loadSkills();
    console.log(fragmentToYaml(mergeFragments(skills)));
  } else {
    boot().catch((err) => { console.error(`boot failed: ${err.message}`); process.exit(1); });
  }
}
