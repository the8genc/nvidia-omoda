#!/usr/bin/env node
// Probe or pair against an OpenClaw gateway, using Paperclip's exact protocol.
//
//   node scripts/gateway-pair.mjs --url ws://127.0.0.1:18789
//   node scripts/gateway-pair.mjs --url ... --approve --token <shared-token>
//
// Probing is read-only: it opens a socket, answers the nonce challenge with our
// device identity, and reports what the gateway says. That is also how a pairing
// request gets filed, which is the intended way to ask.
//
// --approve is a WRITE against whoever owns the gateway. On the shared box that
// is another team's service, which by our own taxonomy is an UPDATE with a
// reputational blast domain. It is gated behind this flag, it is never implied
// by a probe, and every attempt lands in the ledger either way.

import { WebSocket } from "ws";
import { readFileSync, existsSync } from "node:fs";
import {
  resolveDeviceIdentity, buildConnectParams, createGatewayClient, isPairingError,
  DEFAULT_SCOPES, DEFAULT_CLIENT_ID, DEFAULT_CLIENT_MODE, DEFAULT_CLIENT_VERSION, DEFAULT_ROLE,
} from "../src/gateway/openclaw.js";
import { createLedger } from "../src/ledger/ledger.js";

// Load .env (gitignored) so a secret like OPENCLAW_GATEWAY_TOKEN can be supplied
// out of band, written by whoever owns it, and never read into this transcript.
// This script only ever prints masked outcomes, never the value.
(function loadEnvFile(path = ".env") {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
})();

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (argv[i + 1]?.startsWith("--") ? true : argv[i + 1] ?? true);
};
const has = (name) => argv.includes(`--${name}`);

const URL_ = flag("url", "ws://127.0.0.1:18789");
const KEY_PATH = flag("key", "var/device/openclaw-device.key");
const TOKEN = flag("token", process.env.OPENCLAW_GATEWAY_TOKEN ?? null);
const PASSWORD = flag("password", process.env.OPENCLAW_GATEWAY_PASSWORD ?? null);
const APPROVE = has("approve");
const TIMEOUT = Number(flag("timeout", 15000));

const c = {
  b: (s) => `\x1b[1m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`,
};
const ok = (s) => console.log(`  ${c.g("OK")}  ${s}`);
const no = (s) => console.log(`  ${c.r("NO")}  ${s}`);
const info = (s) => console.log(`  ${c.dim(s)}`);

const ledger = createLedger({ path: process.env.OMODA_LEDGER ?? "var/ledger/actions.jsonl" });
const record = (outcome, extra = {}) => {
  try {
    ledger.append({
      kind: "gateway", agent: "omoda:integration", tool: "openclaw.device.pair",
      verb: APPROVE ? "update" : "read", target: URL_, outcome, ...extra,
    });
  } catch (err) { console.error(`  ledger append failed: ${err.message}`); }
};

async function session({ identity, scopes, authToken, password, label }) {
  const client = createGatewayClient({ url: URL_, WebSocketImpl: WebSocket });
  await client.open({ timeoutMs: TIMEOUT });
  info(`${label}: socket open`);
  const nonce = await client.awaitChallenge({ timeoutMs: TIMEOUT });
  info(`${label}: challenge nonce ${nonce}`);
  const params = buildConnectParams({
    nonce, identity, scopes,
    authToken: authToken ?? undefined, password: password ?? undefined,
    clientId: DEFAULT_CLIENT_ID, clientMode: DEFAULT_CLIENT_MODE,
    clientVersion: DEFAULT_CLIENT_VERSION, role: DEFAULT_ROLE,
  });
  const hello = await client.request("connect", params, { timeoutMs: TIMEOUT });
  return { client, hello, nonce };
}

async function main() {
  console.log(c.b(`\nOpenClaw gateway ${APPROVE ? "pairing" : "probe"}: ${URL_}\n`));

  info(`gateway token: ${TOKEN ? `${String(TOKEN).length} chars loaded` : "MISSING (not in --token, env, or .env)"}`);
  const identity = resolveDeviceIdentity({ keyPath: KEY_PATH });
  info(`device id  ${identity.deviceId}`);
  info(`key source ${identity.source} (${KEY_PATH})`);
  if (identity.source === "generated") info("new key written; this device id is now stable across runs");
  console.log("");

  // ── 1. connect as ourselves ─────────────────────────────────────────────
  let primary = null;
  try {
    primary = await session({ identity, scopes: DEFAULT_SCOPES, authToken: TOKEN, password: PASSWORD, label: "connect" });
    ok(`connected. protocol=${primary.hello?.protocol ?? "?"}`);
    record("connected", { deviceId: identity.deviceId });
    const hello = primary.hello ?? {};
    if (hello.server) info(`server ${hello.server.version} connId=${hello.server.connId}`);
    const methods = hello.features?.methods ?? [];
    if (methods.length) {
      info(`${methods.length} methods exposed to Layer 1`);
      const agentMethods = methods.filter((m) => /^agent|^task|^session|^run/.test(m));
      if (agentMethods.length) info(`agent surface: ${agentMethods.slice(0, 12).join(", ")}`);
    }
    primary.client.close();
    console.log(c.g("\n  This device is paired. The seam is open end to end.\n"));
    return;
  } catch (err) {
    if (!isPairingError(err)) {
      no(`connect failed for a reason that is not pairing: ${err.code ?? ""} ${err.message}`);
      record("error", { reason: err.message });
      process.exitCode = 1;
      return;
    }
    no(`${err.code ?? "NOT_PAIRED"}: ${err.message}`);
    info(`details: ${JSON.stringify(err.details ?? {})}`);
    record("pairing-required", { deviceId: identity.deviceId, code: err.code });
  }

  console.log("");
  if (!APPROVE) {
    console.log(c.y("  A pairing request has been filed for this device id."));
    console.log("  Approving it is a write against whoever owns this gateway.");
    console.log("  Re-run with --approve (and --token/--password) to complete it.\n");
    return;
  }

  // ── 2. approve, on a second session carrying operator.pairing ───────────
  if (!TOKEN && !PASSWORD) {
    no("--approve needs a shared --token or --password");
    info("the gateway authenticates the approving session separately; a device");
    info("identity alone cannot approve itself, which is the point of pairing");
    record("refused", { reason: "no shared credential" });
    process.exitCode = 1;
    return;
  }

  const approvalScopes = [...new Set([...DEFAULT_SCOPES, "operator.pairing"])];
  let admin;
  try {
    admin = await session({ identity: null, scopes: approvalScopes, authToken: TOKEN, password: PASSWORD, label: "approve" });
    ok("approving session connected");
  } catch (err) {
    no(`the approving session was refused: ${err.code ?? ""} ${err.message}`);
    record("refused", { reason: err.message });
    process.exitCode = 1;
    return;
  }

  try {
    const list = await admin.client.request("device.pair.list", {}, { timeoutMs: TIMEOUT });
    const pending = (Array.isArray(list?.pending) ? list.pending : []).filter(Boolean);
    info(`${pending.length} pending pairing request(s)`);
    const match = pending.find((p) => p?.deviceId === identity.deviceId) ?? pending[pending.length - 1];
    if (!match?.requestId) {
      no("no pending pairing request to approve");
      record("no-request");
      process.exitCode = 1;
      return;
    }
    if (match.deviceId !== identity.deviceId) {
      no(`refusing: newest pending request is ${match.deviceId}, not our device`);
      info("approving someone else's device is not ours to do");
      record("refused", { reason: "pending request belongs to another device" });
      process.exitCode = 1;
      return;
    }
    await admin.client.request("device.pair.approve", { requestId: match.requestId }, { timeoutMs: TIMEOUT });
    ok(`approved request ${match.requestId}`);
    record("approved", { deviceId: identity.deviceId, requestId: match.requestId });
  } catch (err) {
    no(`pairing failed: ${err.code ?? ""} ${err.message}`);
    record("error", { reason: err.message });
    process.exitCode = 1;
    return;
  } finally {
    admin.client.close();
  }

  // ── 3. prove it by reconnecting as ourselves ───────────────────────────
  console.log("");
  try {
    const again = await session({ identity, scopes: DEFAULT_SCOPES, authToken: TOKEN, password: PASSWORD, label: "verify" });
    ok(`reconnected as a paired device. protocol=${again.hello?.protocol ?? "?"}`);
    again.client.close();
    record("verified", { deviceId: identity.deviceId });
    console.log(c.g("\n  Paired and verified.\n"));
  } catch (err) {
    no(`still refused after approval: ${err.code ?? ""} ${err.message}`);
    record("verify-failed", { reason: err.message });
    process.exitCode = 1;
  }
}

main().catch((err) => { console.error(`\n${err.stack}\n`); process.exit(1); });
