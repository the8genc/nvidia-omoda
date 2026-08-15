// The inference client. This is where Nemotron actually runs.
//
// Until now the router decided WHICH model should serve a task and nothing
// called one. This closes that gap: the routing decision is executed against a
// real endpoint, and every call is recorded with the model that served it, so
// "multi-model" is a measurement rather than a claim.
//
// Two properties matter more than throughput here:
//
//   1. Egress is the policy's business. The local endpoint is
//      host.openshell.internal:8000, which the compiled OpenShell fragment grants
//      as protocol: rest with explicit methods. A call to anything else is not
//      "slower", it is denied at Layer 3.
//
//   2. Model output is a PROPOSAL, never authority. Nothing here returns a
//      decision, a capability, or an approval. The planner may only name a tool
//      that already exists in the capability registry; anything else is
//      undeclared and dies at the Broker. A prompt-injected model is therefore a
//      model that proposes something that gets refused, not one that acts.

import { RoutingRefused } from "./router.js";

export class InferenceError extends Error {
  constructor(message, { status = null, model = null } = {}) {
    super(message);
    this.name = "InferenceError";
    this.status = status;
    this.model = model;
  }
}

/**
 * @param {object} opts
 * @param {typeof fetch} [opts.fetchImpl] injected so tests never touch a socket
 * @param {number} [opts.timeoutMs]
 */
export function createInferenceClient({ fetchImpl = globalThis.fetch, timeoutMs = 120_000, apiKey = null } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("inference client requires fetch");

  /**
   * One completion. Returns the text plus the metadata the ledger needs to make
   * G7 measurable: which model served it, on which endpoint, and how long it took.
   */
  async function complete({ model, endpoint, messages, maxTokens = 512, temperature = 0, signal = null }) {
    if (!model || !endpoint) {
      throw new RoutingRefused("refusing to infer without a routed model and endpoint");
    }
    const started = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
        signal: signal ?? ac.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new InferenceError(`inference failed: HTTP ${res.status} ${detail.slice(0, 200)}`, {
          status: res.status, model,
        });
      }
      const body = await res.json();
      const text = body?.choices?.[0]?.message?.content ?? "";
      return {
        text,
        model: body?.model ?? model,
        endpoint,
        latencyMs: Date.now() - started,
        usage: body?.usage ?? null,
        finishReason: body?.choices?.[0]?.finish_reason ?? null,
      };
    } catch (err) {
      if (err instanceof InferenceError || err instanceof RoutingRefused) throw err;
      if (err?.name === "AbortError") {
        throw new InferenceError(`inference timed out after ${timeoutMs}ms`, { model });
      }
      throw new InferenceError(`inference unreachable: ${err.message}`, { model });
    } finally {
      clearTimeout(timer);
    }
  }

  return { complete };
}

/**
 * Strip a reasoning model's thinking block. Nemotron 3 Nano Omni is a reasoning
 * model, so its raw output can carry a <think> section that is not the answer.
 * Parsing must not be fooled by it, and neither should a human reading a ledger.
 */
export function stripReasoning(text) {
  return String(text ?? "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/**
 * Pull the first JSON object out of a model response. Models wrap JSON in prose
 * or fences no matter how firmly asked not to; that is a parsing problem, not a
 * reason to trust or distrust the content.
 *
 * @returns {object|null} null when there is nothing parseable, never a throw:
 *   an unparseable plan is a plan we refuse, handled by the caller.
 */
export function extractJson(text) {
  const clean = stripReasoning(text).replace(/```(?:json)?/gi, "");
  const start = clean.indexOf("{");
  if (start === -1) return null;
  // Walk to the matching brace so trailing prose does not break the parse.
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < clean.length; i++) {
    const ch = clean[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(clean.slice(start, i + 1)); }
        catch { return null; }
      }
    }
  }
  return null;
}
