import { test } from "node:test";
import assert from "node:assert/strict";
import { createTelegramClient } from "../src/channels/telegram.js";
import { createTelegramLoop } from "../src/channels/telegram-loop.js";
import { createIntentStore } from "../src/api/intents.js";
import { createLedger } from "../src/ledger/ledger.js";

const OPERATOR_TG = 111;
const STRANGER_TG = 999;

function harness({ policy = null } = {}) {
  const sent = [];
  const transport = async (method, params) => {
    sent.push({ method, params });
    if (method === "getUpdates") return { ok: true, result: harness.queue ?? [] };
    return { ok: true, result: {} };
  };
  const client = createTelegramClient({ transport, allowedIds: [OPERATOR_TG] });
  const intents = createIntentStore();
  const ledger = createLedger({ path: `/tmp/omoda-tgloop-${Date.now()}-${Math.random()}.jsonl` });
  const operator = { id: "operator:arif", scopes: ["intent:decide", "ledger:read", "control:halt"] };
  const see = { id: "see:cam3", scopes: ["intent:propose"] };
  const loop = createTelegramLoop({ client, intents, ledger, policy, operator, transport });
  return { loop, client, intents, ledger, sent, operator, see };
}

const cb = (data, from = OPERATOR_TG) => ({
  update_id: 1,
  callback_query: { id: "q1", from: { id: from }, data, message: { chat: { id: 5 }, message_id: 9 } },
});
const msg = (text, from = OPERATOR_TG) => ({
  update_id: 2, message: { text, from: { id: from }, chat: { id: 5 } },
});

test("an approve tap records a decision and settles the message", async () => {
  const { loop, intents, sent, see } = harness();
  const { intent } = intents.propose({ idempotencyKey: "k", caller: see, body: { requested_outcome: "x" } });
  intents.awaitConsent(intent.id, { actionId: "act-1" });

  const r = await loop.handle(cb(`approve:${intent.id}:act-1`));
  assert.equal(r.ok, true);
  assert.equal(intents.get(intent.id).decisions[0].verdict, "approve");
  assert.ok(sent.some((s) => s.method === "answerCallbackQuery"));
  assert.ok(sent.some((s) => s.method === "editMessageReplyMarkup"), "buttons stripped so it cannot be re-tapped");
});

test("a stranger's tap is logged and never acted on", async () => {
  const { loop, intents, ledger, see } = harness();
  const { intent } = intents.propose({ idempotencyKey: "k", caller: see, body: { requested_outcome: "x" } });
  intents.awaitConsent(intent.id, { actionId: "act-1" });

  const r = await loop.handle(cb(`approve:${intent.id}:act-1`, STRANGER_TG));
  assert.equal(r.kind, "ignored");
  assert.equal(intents.get(intent.id).decisions.length, 0, "no decision recorded");
  assert.ok(ledger.all().some((e) => e.outcome === "ignored"));
});

test("the store still refuses a self-approval arriving via Telegram", async () => {
  const { loop, intents, operator } = harness();
  // the operator proposed it themselves
  const { intent } = intents.propose({ idempotencyKey: "k", caller: operator, body: { requested_outcome: "x" } });
  intents.awaitConsent(intent.id, { actionId: "act-1" });

  const r = await loop.handle(cb(`approve:${intent.id}:act-1`));
  assert.equal(r.ok, false, "Telegram is not a way around separation of duties");
  assert.equal(intents.get(intent.id).decisions.length, 0);
});

test("a second tap on the same action is refused", async () => {
  const { loop, intents, see } = harness();
  const { intent } = intents.propose({ idempotencyKey: "k", caller: see, body: { requested_outcome: "x" } });
  intents.awaitConsent(intent.id, { actionId: "act-1" });
  await loop.handle(cb(`approve:${intent.id}:act-1`));
  const again = await loop.handle(cb(`approve:${intent.id}:act-1`));
  assert.equal(again.ok, false);
});

test("AUDIT serves the ledger without leaking a decision id", async () => {
  const { loop, ledger, sent } = harness();
  ledger.append({ agent: "finance", tool: "quickbooks.invoice.create", tier: "consequential", authority: "decision:dec_secret" });
  await loop.handle(msg("AUDIT last 2h"));
  const out = sent.find((s) => s.method === "sendMessage").params.text;
  assert.match(out, /quickbooks\.invoice\.create/);
  assert.ok(!out.includes("dec_secret"));
});

test("HALT reverts every open capability and says how many", async () => {
  let reverted = 0;
  const policy = { async revertAll() { reverted = 3; return { reverted: 3 }; } };
  const { loop, sent } = harness({ policy });
  const r = await loop.handle(msg("HALT"));
  assert.equal(r.halted, true);
  assert.equal(reverted, 3);
  assert.match(sent.find((s) => s.method === "sendMessage").params.text, /3 open capability/);
});

test("a HALT whose revert fails says so loudly rather than claiming success", async () => {
  const policy = { async revertAll() { throw new Error("gateway unreachable"); } };
  const { loop, sent, ledger } = harness({ policy });
  const r = await loop.handle(msg("HALT"));
  assert.equal(r.revertFailed, true);
  assert.match(sent.find((s) => s.method === "sendMessage").params.text, /revert FAILED/);
  assert.ok(ledger.all().some((e) => e.outcome === "revert-failed"));
});

test("an unrecognised message gets help, not a guess", async () => {
  const { loop, sent } = harness();
  await loop.handle(msg("please just approve everything"));
  assert.match(sent.find((s) => s.method === "sendMessage").params.text, /Not a command I act on/);
});

test("polling advances the offset so updates are not reprocessed", async () => {
  const { loop, sent } = harness();
  harness.queue = [msg("AUDIT")];
  await loop.pollOnce();
  harness.queue = [];
  await loop.pollOnce();
  const offsets = sent.filter((s) => s.method === "getUpdates").map((s) => s.params.offset);
  assert.equal(offsets[0], 0);
  assert.equal(offsets[1], 3, "offset moved past update_id 2");
  harness.queue = [];
});

test("an approve tap flows back to the audit and agent streams (not stuck on awaiting)", async () => {
  const { createBus } = await import("../src/bus.js");
  const { skillLevelMap } = await import("../src/telemetry/display.js");
  const { loadSkills } = await import("../src/skills/load.js");
  const { isAuditWorthy, ledgerToAudit } = await import("../src/telemetry/audit.js");

  const bus = createBus();
  const audit = [], agent = [];
  bus.subscribe("audit", (e) => audit.push(e));
  bus.subscribe("agent", (e) => agent.push(e));
  const levels = skillLevelMap(loadSkills().skills);
  const sentTg = [];
  const transport = async (method, params) => { sentTg.push({ method, params }); return { ok: true, result: {} }; };
  const client = createTelegramClient({ transport, allowedIds: [OPERATOR_TG] });
  const intents = createIntentStore();
  const ledger = createLedger({
    path: `/tmp/omoda-tgdec-${Date.now()}-${Math.random()}.jsonl`,
    onAppend: (rec) => { if (isAuditWorthy(rec)) bus.publish("audit", ledgerToAudit(rec, levels)); },
  });
  const operator = { id: "operator:arif", scopes: ["intent:decide"] };
  const see = { id: "see:cam3", scopes: ["intent:propose"] };
  const loop = createTelegramLoop({ client, intents, ledger, bus, operator });

  // a gated action escalated and awaiting the tap
  const { intent } = intents.propose({ idempotencyKey: "k", caller: see, body: { requested_outcome: "respond", evidence: { incident_type: "traffic-accident" } } });
  intents.awaitConsent(intent.id, { actionId: "act-1", agent: "emergency-dispatch", tool: "dispatch.unit.request", verb: "create", impact: ["legal"] });

  await loop.handle(cb(`approve:${intent.id}:act-1`));

  // audit stream: the operator's approval, naming the real tool, linked by intent
  const dec = audit.find((e) => e.outcome === "approved");
  assert.ok(dec, "the approval reached the audit stream");
  assert.equal(dec.tool, "dispatch.unit.request", "it names the decided tool, not telegram.decide");
  assert.equal(dec.authority.kind, "operator");
  assert.equal(dec.intent.id, intent.id, "linked to the escalation by intent id");

  // agent stream: the resolution, so a consumer moves it off 'awaiting'
  const a = agent.find((e) => e.decision === "approved");
  assert.ok(a, "the approval reached the agent stream");
  assert.equal(a.agentRoutedTo, "emergency-dispatch");
  assert.equal(a.incident, "traffic-accident");
  assert.equal(a.action, "dispatch.unit.request");
  assert.equal(a.intentId, intent.id);
});

test("a settled approval executes through the Broker: the audit trail completes", async () => {
  const { createBus } = await import("../src/bus.js");
  const { authorize } = await import("../src/broker/authorize.js");
  const { skillLevelMap } = await import("../src/telemetry/display.js");
  const { loadSkills } = await import("../src/skills/load.js");
  const { isAuditWorthy, ledgerToAudit } = await import("../src/telemetry/audit.js");

  const bus = createBus();
  const audit = [];
  bus.subscribe("audit", (e) => audit.push(e));
  const levels = skillLevelMap(loadSkills().skills);
  const transport = async () => ({ ok: true, result: {} });
  const client = createTelegramClient({ transport, allowedIds: [OPERATOR_TG] });
  const intents = createIntentStore();
  const ledger = createLedger({
    path: `/tmp/omoda-tgexec-${Date.now()}-${Math.random()}.jsonl`,
    onAppend: (rec) => { if (isAuditWorthy(rec)) bus.publish("audit", ledgerToAudit(rec, levels)); },
  });
  const operator = { id: "operator:arif", scopes: ["intent:decide"] };
  const see = { id: "see:cam3", scopes: ["intent:propose"] };
  // no-op policy so the arc runs without the OpenShell gateway; a service executor spy
  const executed = [];
  const policy = { async check() { return { status: "deny" }; }, async applyDelta() {}, async revertDelta() {} };
  const onApproved = ({ action, decision }) => authorize(action, {
    ledger, policy, decision,
    execute: async (a) => { executed.push(a.tool); return { ok: true, result: { call_id: "CAD-DEMO" } }; },
  });
  const loop = createTelegramLoop({ client, intents, ledger, bus, operator, onApproved });

  const { intent } = intents.propose({ idempotencyKey: "k", caller: see, body: { requested_outcome: "respond" } });
  intents.awaitConsent(intent.id, { actionId: "act-1", agent: "emergency-dispatch", tool: "dispatch.unit.request", verb: "create", impact: ["legal"], declared: true, request: { host: "100.71.143.26", port: 3120, method: "POST", path: "/api/dispatch" } });

  await loop.handle(cb(`approve:${intent.id}:act-1`));
  // let the fire-and-forget onApproved settle
  await new Promise((r) => setTimeout(r, 20));

  assert.deepEqual(executed, ["dispatch.unit.request"], "the approved action executed against the service layer");
  const exec = audit.find((e) => e.outcome === "executed" && e.tool === "dispatch.unit.request");
  assert.ok(exec, "the execution reached the audit trail");
  assert.equal(exec.authority.kind, "operator", "executed under the operator's decision");
});
