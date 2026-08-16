// The output layer (the demo app's side of the hub).
//
// Three WebSocket endpoints on the stream server, each a live view of one bus
// topic:
//
//   /v1/out/frames        the relayed COCO video feed, one JSON per frame
//   /v1/out/observations  COCO descriptions plus OMODA's judgment of each
//   /v1/out/agents        realtime agent activity: every ledgered action as it
//                         lands (broker admits and refusals, judge verdicts,
//                         escalations, decisions, gateway and telegram events)
//
// Read requires a token like everything else: a viewer holds intent:read and
// nothing else, so the demo app can watch the platform and cannot drive it.
// Frames are heavy (~55 KB each); a subscriber that falls behind gets frames
// DROPPED, not queued, because a realtime view that lags a minute is worse
// than one that skips.

import { SCOPES } from "./auth.js";

const TOPIC_BY_PATH = Object.freeze({
  "/v1/out/frames": "frame",
  "/v1/out/observations": "observation",
  "/v1/out/agents": "agent",
});

const MAX_BUFFERED = 2 * 1024 * 1024; // beyond this, drop rather than lag

export function outputTopicFor(pathname) {
  return TOPIC_BY_PATH[pathname] ?? null;
}

/** Accept-time auth for a viewer: read scope, nothing more demanded. */
export function acceptViewer({ headers = {}, tokens }) {
  const auth = headers["authorization"] ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  const caller = bearer ? tokens.get(bearer) : null;
  if (!caller) return { ok: false, code: 4401, reason: "unknown token" };
  if (!caller.scopes.includes(SCOPES.READ)) {
    return { ok: false, code: 4403, reason: `output streams require ${SCOPES.READ}` };
  }
  return { ok: true, caller };
}

/**
 * Bridge one accepted socket to one bus topic, with drop-not-lag semantics.
 * Returns the unsubscribe function.
 */
export function bridgeSocket({ ws, bus, topic, maxBuffered = MAX_BUFFERED }) {
  let sent = 0, dropped = 0;
  const unsubscribe = bus.subscribe(topic, (event) => {
    if (ws.readyState !== 1) return;
    if ((ws.bufferedAmount ?? 0) > maxBuffered) { dropped += 1; return; }
    try { ws.send(JSON.stringify(event)); sent += 1; } catch { /* close handles it */ }
  });
  ws.on("close", unsubscribe);
  return { unsubscribe, stats: () => ({ sent, dropped }) };
}
