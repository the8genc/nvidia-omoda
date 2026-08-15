import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import {
  PROTOCOL_VERSION, DEFAULT_SCOPES, DEFAULT_CLIENT_ID, DEFAULT_CLIENT_MODE, DEFAULT_ROLE,
  resolveDeviceIdentity, buildDeviceAuthPayloadV3, buildConnectParams, derivePublicKeyRaw,
  createGatewayClient, isPairingError,
} from "../src/gateway/openclaw.js";

// These are Paperclip's values, not ours. If the adapter changes them, our
// "verified seam" claim stops being true, and this is the test that says so.
test("the protocol constants still match Paperclip's adapter", () => {
  assert.equal(PROTOCOL_VERSION, 4);
  assert.equal(DEFAULT_CLIENT_ID, "gateway-client");
  assert.equal(DEFAULT_CLIENT_MODE, "backend");
  assert.equal(DEFAULT_ROLE, "operator");
  assert.deepEqual(DEFAULT_SCOPES, ["operator.admin"]);
});

test("a device id is derived from the key, not asserted", () => {
  const id = resolveDeviceIdentity();
  const raw = derivePublicKeyRaw(
    crypto.createPublicKey(crypto.createPrivateKey(id.privateKeyPem))
      .export({ type: "spki", format: "pem" }).toString(),
  );
  assert.equal(raw.length, 32, "ed25519 raw public key is 32 bytes");
  assert.equal(id.deviceId, crypto.createHash("sha256").update(raw).digest("hex"));
  assert.equal(id.publicKeyRawBase64Url.includes("="), false, "base64url is unpadded");
  assert.match(id.publicKeyRawBase64Url, /^[A-Za-z0-9_-]+$/);
});

test("the signed payload is exactly the eleven pipe-joined v3 fields", () => {
  const payload = buildDeviceAuthPayloadV3({
    deviceId: "dev1", clientId: "gateway-client", clientMode: "backend", role: "operator",
    scopes: ["operator.admin", "extra"], signedAtMs: 1786807750042, token: null,
    nonce: "n-1", platform: "linux", deviceFamily: null,
  });
  assert.equal(
    payload,
    "v3|dev1|gateway-client|backend|operator|operator.admin,extra|1786807750042||n-1|linux|",
  );
  assert.equal(payload.split("|").length, 11);
});

test("an absent token and device family sign as empty strings, not as 'null'", () => {
  const payload = buildDeviceAuthPayloadV3({
    deviceId: "d", clientId: "c", clientMode: "backend", role: "operator",
    scopes: [], signedAtMs: 1, nonce: "n",
  });
  assert.ok(!payload.includes("null"), payload);
  assert.ok(!payload.includes("undefined"), payload);
});

test("the connect frame carries a signature the public key verifies", () => {
  const identity = resolveDeviceIdentity();
  const params = buildConnectParams({ nonce: "nonce-abc", identity, platform: "linux", signedAtMs: 1700 });

  assert.equal(params.minProtocol, 4);
  assert.equal(params.maxProtocol, 4);
  assert.equal(params.client.id, "gateway-client");
  assert.equal(params.client.mode, "backend");
  assert.equal(params.role, "operator");
  assert.deepEqual(params.scopes, ["operator.admin"]);
  assert.equal(params.device.nonce, "nonce-abc");
  assert.equal(params.device.id, identity.deviceId);

  // Verify the way the gateway would: rebuild the payload, check the signature
  // against the raw public key we transmitted.
  const expected = buildDeviceAuthPayloadV3({
    deviceId: identity.deviceId, clientId: "gateway-client", clientMode: "backend",
    role: "operator", scopes: ["operator.admin"], signedAtMs: 1700, token: null,
    nonce: "nonce-abc", platform: "linux", deviceFamily: null,
  });
  const spki = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    Buffer.from(params.device.publicKey.replaceAll("-", "+").replaceAll("_", "/"), "base64"),
  ]);
  const pub = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
  const sig = Buffer.from(params.device.signature.replaceAll("-", "+").replaceAll("_", "/"), "base64");
  assert.equal(crypto.verify(null, Buffer.from(expected, "utf8"), pub, sig), true);
});

test("a signature over a different nonce does not verify, so the challenge is doing work", () => {
  const identity = resolveDeviceIdentity();
  const params = buildConnectParams({ nonce: "nonce-A", identity, platform: "linux", signedAtMs: 1700 });
  const wrong = buildDeviceAuthPayloadV3({
    deviceId: identity.deviceId, clientId: "gateway-client", clientMode: "backend",
    role: "operator", scopes: ["operator.admin"], signedAtMs: 1700, token: null,
    nonce: "nonce-B", platform: "linux", deviceFamily: null,
  });
  const spki = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    Buffer.from(params.device.publicKey.replaceAll("-", "+").replaceAll("_", "/"), "base64"),
  ]);
  const pub = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
  const sig = Buffer.from(params.device.signature.replaceAll("-", "+").replaceAll("_", "/"), "base64");
  assert.equal(crypto.verify(null, Buffer.from(wrong, "utf8"), pub, sig), false);
});

test("without a device identity the frame carries no device block at all", () => {
  const params = buildConnectParams({ nonce: "n" });
  assert.equal(params.device, undefined);
  assert.equal(params.auth, undefined, "no credentials means no auth block, not an empty one");
});

test("a persisted key yields a stable device id across restarts", (t) => {
  const path = `/tmp/omoda-dev-${process.pid}-${Math.random().toString(16).slice(2)}.key`;
  t.after(() => { try { require("node:fs").unlinkSync(path); } catch { /* fine */ } });
  const first = resolveDeviceIdentity({ keyPath: path });
  const second = resolveDeviceIdentity({ keyPath: path });
  assert.equal(first.source, "generated");
  assert.equal(second.source, "persisted");
  assert.equal(first.deviceId, second.deviceId,
    "an ephemeral key would file a fresh pairing request on every connect");
});

// ── the frame exchange ────────────────────────────────────────────────────
class FakeSocket extends EventEmitter {
  constructor() { super(); this.sent = []; }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.emit("close", 1000, Buffer.from("")); }
}

function fakeClient() {
  let socket;
  const WebSocketImpl = function () { socket = new FakeSocket(); return socket; };
  const client = createGatewayClient({ url: "ws://127.0.0.1:18789", WebSocketImpl });
  return { client, sock: () => socket };
}

test("the client waits for the gateway's challenge before it sends connect", async () => {
  const { client, sock } = fakeClient();
  const opened = client.open();
  sock().emit("open");
  await opened;

  const waiting = client.awaitChallenge({ timeoutMs: 500 });
  assert.equal(sock().sent.length, 0, "nothing is sent until the nonce arrives");
  sock().emit("message", JSON.stringify({
    type: "event", event: "connect.challenge", payload: { nonce: "n-42", ts: 1 },
  }));
  assert.equal(await waiting, "n-42");
});

test("a res frame resolves the matching req by id", async () => {
  const { client, sock } = fakeClient();
  const opened = client.open();
  sock().emit("open");
  await opened;

  const pending = client.request("connect", { minProtocol: 4 }, { timeoutMs: 500 });
  const sent = sock().sent[0];
  assert.equal(sent.type, "req");
  assert.equal(sent.method, "connect");
  sock().emit("message", JSON.stringify({ type: "res", id: sent.id, ok: true, payload: { protocol: 4 } }));
  assert.deepEqual(await pending, { protocol: 4 });
});

test("a refusal surfaces the gateway's own error code, not a generic failure", async () => {
  const { client, sock } = fakeClient();
  const opened = client.open();
  sock().emit("open");
  await opened;

  const pending = client.request("connect", {}, { timeoutMs: 500 });
  const sent = sock().sent[0];
  sock().emit("message", JSON.stringify({
    type: "res", id: sent.id, ok: false,
    error: { code: "NOT_PAIRED", message: "device identity required", details: { code: "DEVICE_IDENTITY_REQUIRED" } },
  }));
  const err = await pending.then(() => null, (e) => e);
  assert.equal(err.code, "NOT_PAIRED");
  assert.equal(err.details.code, "DEVICE_IDENTITY_REQUIRED");
  assert.equal(isPairingError(err), true);
});

test("an unrelated error is not mistaken for a pairing problem", () => {
  const err = new Error("boom");
  err.code = "INTERNAL";
  assert.equal(isPairingError(err), false);
});

test("closing the socket rejects everything still in flight", async () => {
  const { client, sock } = fakeClient();
  const opened = client.open();
  sock().emit("open");
  await opened;

  const pending = client.request("agent", {}, { timeoutMs: 2000 });
  sock().emit("close", 1008, Buffer.from("device identity required"));
  const err = await pending.then(() => null, (e) => e);
  assert.match(err.message, /gateway closed \(1008\)/);
});
