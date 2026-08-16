// Agentic telemetry: the fine-grained stream behind /v1/out/agentic.
//
// The ledger stream (/v1/out/agents) is the audit: durable, hash-chained,
// deliberately terse. THIS stream is the narration: orchestration decisions,
// agent-to-agent messages, tool invocations, API calls and what came back,
// inference requests and their latency. It exists for the demo dashboard, so
// events are typed, correlated, and size-bounded.
//
// Telemetry is observability, never authority: nothing reads this stream to
// decide anything, emitters never throw into their callers, and payloads are
// truncated and secret-stripped before they leave the process.

import { randomUUID } from "node:crypto";

export const AGENTIC_EVENTS = Object.freeze([
  "orchestration.route",   // L0/router decided who or what handles a request
  "agent.message",         // one agent handing work or findings to another
  "tool.call",             // an agent invoking a declared tool
  "tool.result",           // what the tool returned (bounded)
  "api.call",              // an outbound API request (host, method, path)
  "api.result",            // status and bounded body of the response
  "inference.call",        // a model request: model, endpoint, purpose
  "inference.result",      // latency, usage, bounded output
]);

const MAX_DETAIL_CHARS = 600;

/** Bound any value to a demo-safe string; strip the obvious secrets. */
export function bound(value, max = MAX_DETAIL_CHARS) {
  let s = typeof value === "string" ? value : JSON.stringify(value ?? null);
  if (s == null) return null;
  s = s
    .replace(/"authorization"\s*:\s*"[^"]*"/gi, '"authorization":"[stripped]"')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, "Bearer [stripped]")
    .replace(/data:(image|video|audio)\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g, "data:$1/...;base64,[stripped]");
  return s.length > max ? `${s.slice(0, max)}…[+${s.length - max} chars]` : s;
}

export function createAgenticTelemetry({ bus } = {}) {
  const emit = (event, fields) => {
    if (!AGENTIC_EVENTS.includes(event)) return null;
    try {
      return bus?.publish("agentic", {
        event,
        correlationId: fields.correlationId ?? randomUUID(),
        ...fields,
        detail: fields.detail === undefined ? null : fields.detail,
      }) ?? null;
    } catch {
      return null; // narration must never break the platform it narrates
    }
  };

  return {
    emit,
    route: (f) => emit("orchestration.route", f),
    message: (f) => emit("agent.message", f),
    toolCall: (f) => emit("tool.call", f),
    toolResult: (f) => emit("tool.result", f),
    apiCall: (f) => emit("api.call", f),
    apiResult: (f) => emit("api.result", f),
    inferenceCall: (f) => emit("inference.call", f),
    inferenceResult: (f) => emit("inference.result", f),
  };
}

// ── process-global sink ─────────────────────────────────────────────────────
// Pure modules (the inference client, the gateway client, the planner) emit
// through this. It is a no-op until boot installs the bus-backed telemetry, so
// tests and library use stay silent by default. Observability is the one place
// a process-global is honest: it carries no authority and nothing reads it back.

let globalTelemetry = null;

export function setGlobalTelemetry(t) { globalTelemetry = t; }

export const telemetry = new Proxy({}, {
  get: (_t, method) => (...args) => {
    const impl = globalTelemetry?.[method];
    return typeof impl === "function" ? impl(...args) : null;
  },
});
