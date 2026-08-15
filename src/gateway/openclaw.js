// OpenClaw gateway protocol v4 client.
//
// This is the seam between Layer 1 (Paperclip orchestration) and Layer 3
// (an agent contained by OpenShell). The A1 spike proved the gateway accepts
// Paperclip's exact connect frame and answers with a nonce challenge, then
// refuses for exactly one reason: no device identity. This module supplies that
// identity.
//
// Every constant and every byte of the signed payload is taken from Paperclip's
// own adapter, @paperclipai/adapter-openclaw-gateway, so that what we send is
// what the adapter would have sent. If these drift, the seam is not verified any
// more, and the tests here are what catch it.

import crypto from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

export const PROTOCOL_VERSION = 4;
export const DEFAULT_SCOPES = ["operator.admin"];
export const DEFAULT_CLIENT_ID = "gateway-client";
export const DEFAULT_CLIENT_MODE = "backend";
export const DEFAULT_CLIENT_VERSION = "paperclip";
export const DEFAULT_ROLE = "operator";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function base64UrlEncode(buf) {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

/** SPKI DER for ed25519 is a fixed 12-byte prefix plus the 32 raw key bytes. */
export function derivePublicKeyRaw(publicKeyPem) {
  const spki = crypto.createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

export function signDevicePayload(privateKeyPem, payload) {
  const key = crypto.createPrivateKey(privateKeyPem);
  return base64UrlEncode(crypto.sign(null, Buffer.from(payload, "utf8"), key));
}

/**
 * The exact string the gateway verifies. Field order is load-bearing: a
 * reordering still signs and still base64s, and fails only at the far end with
 * a generic signature error.
 */
export function buildDeviceAuthPayloadV3(params) {
  return [
    "v3",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(params.signedAtMs),
    params.token ?? "",
    params.nonce,
    params.platform?.trim() ?? "",
    params.deviceFamily?.trim() ?? "",
  ].join("|");
}

/**
 * A device is its keypair. The id is the hash of the raw public key, so it is
 * derived, not asserted: you cannot claim someone else's device id without
 * their private key.
 *
 * Persisting the key matters. An ephemeral key means a new device id on every
 * connect, and every connect files a fresh pairing request against whoever owns
 * the gateway. That is rude on shared infrastructure.
 */
export function resolveDeviceIdentity({ privateKeyPem = null, keyPath = null } = {}) {
  let pem = privateKeyPem;
  let source = "configured";

  if (!pem && keyPath && existsSync(keyPath)) {
    pem = readFileSync(keyPath, "utf8");
    source = "persisted";
  }

  if (!pem) {
    const generated = crypto.generateKeyPairSync("ed25519");
    pem = generated.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    source = keyPath ? "generated" : "ephemeral";
    if (keyPath) {
      mkdirSync(dirname(keyPath), { recursive: true });
      writeFileSync(keyPath, pem, { mode: 0o600 });
      chmodSync(keyPath, 0o600);
    }
  }

  const privateKey = crypto.createPrivateKey(pem);
  const publicKeyPem = crypto.createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  const raw = derivePublicKeyRaw(publicKeyPem);

  return {
    deviceId: crypto.createHash("sha256").update(raw).digest("hex"),
    publicKeyRawBase64Url: base64UrlEncode(raw),
    privateKeyPem: pem,
    source,
  };
}

export function buildConnectParams({
  nonce,
  identity = null,
  clientId = DEFAULT_CLIENT_ID,
  clientMode = DEFAULT_CLIENT_MODE,
  clientVersion = DEFAULT_CLIENT_VERSION,
  role = DEFAULT_ROLE,
  scopes = DEFAULT_SCOPES,
  platform = process.platform,
  deviceFamily = null,
  authToken = null,
  deviceToken = null,
  password = null,
  signedAtMs = Date.now(),
}) {
  const params = {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: {
      id: clientId,
      version: clientVersion,
      platform,
      ...(deviceFamily ? { deviceFamily } : {}),
      mode: clientMode,
    },
    role,
    scopes,
    auth:
      authToken || password || deviceToken
        ? {
            ...(authToken ? { token: authToken } : {}),
            ...(deviceToken ? { deviceToken } : {}),
            ...(password ? { password } : {}),
          }
        : undefined,
  };

  if (identity) {
    const payload = buildDeviceAuthPayloadV3({
      deviceId: identity.deviceId,
      clientId,
      clientMode,
      role,
      scopes,
      signedAtMs,
      token: authToken,
      nonce,
      platform,
      deviceFamily,
    });
    params.device = {
      id: identity.deviceId,
      publicKey: identity.publicKeyRawBase64Url,
      signature: signDevicePayload(identity.privateKeyPem, payload),
      signedAt: signedAtMs,
      nonce,
    };
  }

  return params;
}

/**
 * Minimal protocol client. `WebSocketImpl` is injected so the tests can drive
 * the frame exchange without a socket.
 */
export function createGatewayClient({ url, headers = {}, WebSocketImpl, onFrame = null }) {
  if (!WebSocketImpl) throw new Error("createGatewayClient requires a WebSocket implementation");

  let ws = null;
  const pending = new Map();
  let resolveChallenge, rejectChallenge;
  const challenge = new Promise((res, rej) => { resolveChallenge = res; rejectChallenge = rej; });
  // A close before anyone awaits the challenge would otherwise escape as an
  // unhandled rejection and take the process down. awaitChallenge still sees it.
  challenge.catch(() => {});
  const events = [];

  function handle(raw) {
    let frame;
    try { frame = JSON.parse(raw); } catch { return; }
    onFrame?.(frame);

    if (frame.type === "event") {
      events.push(frame);
      if (frame.event === "connect.challenge") resolveChallenge(frame.payload?.nonce);
      return;
    }
    if (frame.type === "res") {
      const p = pending.get(frame.id);
      if (!p) return;
      pending.delete(frame.id);
      if (frame.ok === false) {
        const err = new Error(frame.error?.message ?? "gateway request failed");
        err.code = frame.error?.code;
        err.details = frame.error?.details;
        p.reject(err);
      } else {
        p.resolve(frame.payload ?? frame.result ?? {});
      }
    }
  }

  function failAll(err) {
    for (const [, p] of pending) p.reject(err);
    pending.clear();
    rejectChallenge(err);
  }

  return {
    events,

    async open({ timeoutMs = 15000 } = {}) {
      ws = new WebSocketImpl(url, { headers, maxPayload: 25 * 1024 * 1024 });
      ws.on("message", (d) => handle(typeof d === "string" ? d : d.toString("utf8")));
      ws.on("close", (code, reason) => {
        const text = typeof reason === "string" ? reason : Buffer.from(reason ?? "").toString("utf8");
        failAll(new Error(`gateway closed (${code}): ${text}`));
      });
      ws.on("error", () => { /* surfaced through close */ });

      await withTimeout(new Promise((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
        ws.once("close", (code) => reject(new Error(`gateway closed before open (${code})`)));
      }), timeoutMs, "gateway websocket open timeout");
    },

    /** The gateway speaks first: it issues the nonce we have to sign. */
    async awaitChallenge({ timeoutMs = 15000 } = {}) {
      return withTimeout(challenge, timeoutMs, "gateway connect challenge timeout");
    },

    request(method, params, { timeoutMs = 15000 } = {}) {
      if (!ws) throw new Error("gateway not connected");
      const id = crypto.randomUUID();
      const frame = { type: "req", id, method, params };
      return withTimeout(new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify(frame));
      }), timeoutMs, `gateway ${method} timeout`);
    },

    close() { try { ws?.close(); } catch { /* already gone */ } },
  };
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/** Errors the gateway raises when a device is known but not yet trusted. */
export const PAIRING_CODES = new Set([
  "NOT_PAIRED",
  "PAIRING_REQUIRED",
  "DEVICE_IDENTITY_REQUIRED",
  "DEVICE_NOT_PAIRED",
]);

export function isPairingError(err) {
  const codes = [err?.code, err?.details?.code].filter(Boolean).map(String);
  return codes.some((c) => PAIRING_CODES.has(c.toUpperCase()));
}
