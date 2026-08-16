// L0: the orchestrator, wired into the standing intake loop.
//
// The judge (or the API, or Telegram) opens an intent: work is requested. L0 is
// what turns "an intent exists" into "this specific declared capability is
// proposed and awaiting consent." It reasons over the registry with Nemotron
// (planAction) to choose the tool, builds the action the Broker will govern, and
// registers it. From there the existing machinery takes over: consent stage,
// escalation, approval-scoped capability, ledger.
//
// L0 selects; it never executes. The tool it names must already be in the
// registry (undeclared is denied), and the verb and impact come from the
// manifest, not from L0, so the orchestrator cannot escalate its own privilege.

import { planAction, PlanRefused } from "./models/plan.js";
import { consentKind } from "./domain/taxonomy.js";
import { telemetry } from "./telemetry/agentic.js";

/**
 * @param {object} opts
 * @param {object} opts.intents   the intent store
 * @param {object} opts.registry  buildCapabilityIndex result
 * @param {object} opts.ledger
 * @param {object} [opts.client]  inference client (planAction default if omitted)
 * @param {() => boolean} [opts.localAvailable]
 * @param {object} [opts.knowledge] retrieval store for L1 context injection
 */
export function createOrchestrator({ intents, registry, ledger, client, localAvailable = () => true, knowledge = null } = {}) {
  if (!intents || !registry) throw new Error("orchestrator requires intents and the registry");

  const record = (entry) => {
    try { ledger?.append({ kind: "orchestrator", agent: "l0", verb: "read", ...entry }); }
    catch { /* best effort; the intent still stands */ }
  };

  /**
   * Route one proposed intent to a capability. Idempotent per intent: if an
   * action is already awaiting consent, do nothing (a redelivery must not
   * double-escalate).
   * @returns {Promise<{routed:boolean, tool?:string, reason?:string}>}
   */
  async function onIntent(intent) {
    if (!intent || intent.actions?.length) return { routed: false, reason: "already routed" };

    // Retrieval context (PRD 23.2): pertinent knowledge tightens the choice.
    let context = "";
    if (knowledge) {
      try {
        const { hits } = await knowledge.retrieve(intent.requestedOutcome ?? "", { k: 3 });
        if (hits?.length) {
          const { contextBlock } = await import("./knowledge/store.js");
          context = contextBlock(hits);
        }
      } catch { /* retrieval is advisory; absence is not failure */ }
    }

    let plan;
    try {
      plan = await planAction({ intent, registry, client, localAvailable: localAvailable(), context });
    } catch (err) {
      if (err instanceof PlanRefused) {
        // The model named something undeclared. That is a refusal, loudly.
        record({ tool: "l0.route", outcome: "refused", reason: err.message.slice(0, 160), intentId: intent.id });
        telemetry.route({ actor: "l0", target: null, intentId: intent.id, detail: { decision: "refused-undeclared", proposed: err.proposed } });
        return { routed: false, reason: err.message };
      }
      record({ tool: "l0.route", outcome: "error", reason: String(err.message).slice(0, 160), intentId: intent.id });
      return { routed: false, reason: err.message };
    }

    if (!plan.tool) {
      record({ tool: "l0.route", outcome: "no-tool", reason: plan.reason?.slice(0, 160), intentId: intent.id });
      return { routed: false, reason: plan.reason };
    }

    const declared = registry.lookup(plan.tool);
    // The action the Broker governs. Verb and impact are the manifest's, never
    // L0's. A destructive verb carries an inverse spec so UNDO has something to
    // replay; the concrete reversal executor is supplied at the call site.
    const isDestructive = declared.verb === "update" || declared.verb === "delete";
    const action = {
      actionId: `l0-${intent.id.slice(0, 12)}-${Date.now()}`,
      agent: declared.agent,
      tool: declared.tool,
      verb: declared.verb,
      impact: declared.impact,
      declared: true,
      reason: plan.reason,
      request: declared.grant
        ? { host: declared.egress?.host, method: declared.verb === "read" ? "GET" : "POST", path: declared.egress?.path ?? "/" }
        : undefined,
      inverse: isDestructive ? { kind: "restore", of: declared.tool } : undefined,
    };

    intents.awaitConsent(intent.id, action);
    const stage = consentKind(declared.verb, declared.impact) ?? "none";
    record({ tool: "l0.route", outcome: "routed", reason: `${plan.tool} -> ${stage}`, intentId: intent.id });
    telemetry.message({ actor: "l0", target: declared.agent, intentId: intent.id, detail: { handoff: "capability-selected", tool: plan.tool, consent: stage } });
    return { routed: true, tool: plan.tool, agent: declared.agent, consent: stage, actionId: action.actionId };
  }

  return { onIntent };
}
