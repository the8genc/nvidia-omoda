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
import { candidateSignals } from "./coco/judge.js";
import { narrateResponse } from "./telemetry/narrate.js";
import { handoffToAudit } from "./telemetry/audit.js";

// L0's routing table: which L1 domain agent owns which incident type. This is
// the deterministic half of "route to an L1". A confirmed incident_type maps
// straight to its domain expert; the demo skills define these L1s.
export const L1_BY_INCIDENT = Object.freeze({
  "traffic-accident": "accident-agent",
  fire: "fire-agent",
  "fallen-signage": "roadside",
  "road-maintenance": "roadside",
  "utility-hazard": "utility-agent",
  "public-warning": "comms-agent",
  other: "roadside",
});

// A purely deterministic domain hint from the raw signals, before any inference.
// L0 uses this to route even when the model is unavailable, and to cross-check
// what the model returns.
export function l1FromSignals(signals) {
  if (signals.some((x) => x.startsWith("vehicle:smoke_or_fire") || x === "description:danger_lexicon")) {
    // fire/smoke words are the strongest deterministic fire signal
    if (signals.some((x) => x.includes("smoke_or_fire")) || signals.includes("followup:danger_true")) return "fire-agent";
  }
  if (signals.some((x) => x.startsWith("interaction:contact") || x.startsWith("changes:new_vehicle_contact") || x.startsWith("vehicle:"))) return "accident-agent";
  if (signals.some((x) => x.startsWith("sign:") || x.startsWith("object:") || x.startsWith("road:"))) return "roadside";
  return null;
}

/**
 * @param {object} opts
 * @param {object} opts.intents   the intent store
 * @param {object} opts.registry  buildCapabilityIndex result
 * @param {object} opts.ledger
 * @param {object} [opts.client]  inference client (planAction default if omitted)
 * @param {() => boolean} [opts.localAvailable]
 * @param {object} [opts.knowledge] retrieval store for L1 context injection
 */
export function createOrchestrator({ intents, registry, ledger, client, localAvailable = () => true, knowledge = null, judge = null, bus = null, levelMap = null } = {}) {
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
      intentId: intent.id,
      agent: declared.agent,
      tool: declared.tool,
      verb: declared.verb,
      impact: declared.impact,
      resource: declared.resource ?? undefined,
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

  /**
   * L0 reviews EVERY frame description off the stream. Deterministic first: cheap
   * signal extraction runs on every frame, so a quiet street costs zero
   * inference. Only when signals fire does detection escalate to the model (the
   * judge's own two stages). L0's job here is the routing decision: does this
   * frame need an L1 domain agent, and which one.
   *
   * @returns {Promise<object>} the judge verdict enriched with the L1 route
   */
  async function reviewObservation(obs, context = []) {
    const signals = candidateSignals(obs);
    const deterministicL1 = l1FromSignals(signals);

    // Quiet frame: no signals, no inference, no route. L0 saw it and passed.
    // (The judge is still consulted so incident clearance advances, but its
    // stage-1 filter means a quiet frame never reaches the model.)
    const verdict = judge ? await judge.onObservation(obs, context) : { verdict: "nominal" };

    if (verdict.verdict === "incident" || verdict.verdict === "attached") {
      const l1 = L1_BY_INCIDENT[verdict.incidentType] ?? deterministicL1 ?? "roadside";
      // The trigger event: L0 saw something and is acting. Record the take-action
      // phrase (when a trigger fired) so the audit trail carries the trigger word.
      record({ tool: "l0.review", outcome: "routed-to-l1", reason: `${verdict.incidentType ?? "?"} -> ${l1}`, intentId: verdict.intentId, triggerPhrase: verdict.trigger ?? null });
      telemetry.route({ actor: "l0", target: l1, intentId: verdict.intentId, detail: { decision: "route-to-l1", incidentType: verdict.incidentType, signals, inferenceUsed: true } });
      // Narrate the whole response flow down the org chart, but only when a NEW
      // incident opens (not on every subsequent frame of the same incident). The
      // same handoffs feed the audit stream as agent-to-agent engagement events.
      if (verdict.verdict === "incident" && bus) {
        for (const ev of narrateResponse({ incidentType: verdict.incidentType, l1, intentId: verdict.intentId }, levelMap)) {
          bus.publish("agent", ev);
          bus.publish("audit", handoffToAudit(ev, levelMap));
        }
      }
      return { ...verdict, reviewed: true, routedToL1: l1, signals, inferenceUsed: true };
    }

    if (signals.length > 0) {
      // Signals fired but the model judged it not an incident: L0 reviewed with
      // inference and deliberately did not route. Worth showing on the stream.
      telemetry.route({ actor: "l0", target: null, detail: { decision: "reviewed-no-route", signals, inferenceUsed: true } });
      return { ...verdict, reviewed: true, routedToL1: null, signals, inferenceUsed: true };
    }

    // Nominal: L0 reviewed deterministically and there was nothing to route.
    return { ...verdict, reviewed: true, routedToL1: null, signals, inferenceUsed: false };
  }

  return {
    onIntent,
    reviewObservation,
    // Drop-in for anywhere a judge with onObservation was expected: L0 is now
    // the front door for frames as well as intents.
    onObservation: reviewObservation,
  };
}
