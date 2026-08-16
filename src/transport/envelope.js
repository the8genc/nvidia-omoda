// The transport layer's one job (PRD 23.1): whatever door data comes through,
// downstream sees exactly one shape. This module is that shape.
//
// An engagement enters through the WebSocket (served or dialed), the API, or
// Telegram. Each door calls createEnvelope at its edge, and the envelope rides
// the intent from then on, so "which door was it" is recorded once and never
// re-derived. An update (PUT) deliberately gets no envelope of its own: it
// rides the engagement it updates.

export const SOURCE = Object.freeze({
  STREAM: "stream",
  API: "api",
  TELEGRAM: "telegram",
});

export const DIRECTION = Object.freeze({
  INBOUND: "inbound",        // the caller reached us: WS connect, POST, a message
  OUTBOUND_DIAL: "outbound-dial", // we reached out to a stream already pushing
});

export const MODALITY = Object.freeze({
  JSON: "json",
  TEXT: "text",
  VOICE: "voice",
  VIDEO: "video",
});

const SOURCES = new Set(Object.values(SOURCE));
const DIRECTIONS = new Set(Object.values(DIRECTION));
const MODALITIES = new Set(Object.values(MODALITY));

/**
 * @returns {Readonly<{source:string,direction:string,modality:string,
 *   idempotency_key:string|null, received_at:string}>}
 */
export function createEnvelope({ source, direction, modality, idempotencyKey = null, now = Date.now } = {}) {
  if (!SOURCES.has(source)) throw new Error(`envelope: unknown source "${source}"`);
  if (!DIRECTIONS.has(direction)) throw new Error(`envelope: unknown direction "${direction}"`);
  if (!MODALITIES.has(modality)) throw new Error(`envelope: unknown modality "${modality}"`);
  return Object.freeze({
    source,
    direction,
    modality,
    idempotency_key: idempotencyKey ?? null,
    received_at: new Date(now()).toISOString(),
  });
}
