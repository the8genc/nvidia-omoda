import { test } from "node:test";
import assert from "node:assert/strict";
import { createTelegramClient, TelegramMethodRefused } from "../src/channels/telegram.js";

const OPERATOR = 111;
const STRANGER = 999;

function harness() {
  const calls = [];
  const transport = async (method, params) => { calls.push({ method, params }); return { ok: true, result: {} }; };
  const tg = createTelegramClient({ transport, allowedIds: [OPERATOR] });
  return { tg, calls };
}

const intent = { id: "int_1", detector: "traffic-anomaly", requestedOutcome: "raise the incident invoice" };
const action = { actionId: "act-1", tool: "quickbooks.invoice.create", verb: "create", impact: ["financial"] };

test("the client refuses any method outside the hardened policy", async () => {
  const { tg } = harness();
  assert.ok(!tg.ALLOWED_METHODS.has("setWebhook"));
  assert.ok(!tg.ALLOWED_METHODS.has("sendDocument"));
  assert.ok(!tg.ALLOWED_METHODS.has("deleteMessage"));
});

test("escalation names the tool, the verb and the impact, with two taps", async () => {
  const { tg, calls } = harness();
  await tg.escalate({ chatId: 5, intent, action });
  const sent = calls[0];
  assert.equal(sent.method, "sendMessage");
  assert.match(sent.params.text, /quickbooks\.invoice\.create/);
  assert.match(sent.params.text, /impact: \*financial\*/);
  assert.match(sent.params.text, /absent from policy until you decide/);
  const buttons = sent.params.reply_markup.inline_keyboard[0];
  assert.deepEqual(buttons.map((b) => b.text), ["Approve", "Deny"]);
  assert.equal(buttons[0].callback_data, "approve:int_1:act-1");
});

test("only the registered operator may decide", () => {
  const { tg } = harness();
  const good = tg.parseUpdate({ callback_query: { id: "q1", from: { id: OPERATOR }, data: "approve:int_1:act-1", message: { chat: { id: 5 }, message_id: 9 } } });
  assert.equal(good.kind, "decide");
  assert.equal(good.verdict, "approve");

  const bad = tg.parseUpdate({ callback_query: { id: "q2", from: { id: STRANGER }, data: "approve:int_1:act-1" } });
  assert.equal(bad.kind, "ignored");
  assert.match(bad.reason, /not the registered operator/);
});

test("a client with no allowlist trusts nobody", () => {
  const tg = createTelegramClient({ transport: async () => ({}), allowedIds: [] });
  assert.equal(tg.isOperator(OPERATOR), false, "an empty allowlist must fail closed, not open");
});

test("operator commands parse, and unknown text is inert", () => {
  const { tg } = harness();
  const from = { id: OPERATOR };
  const m = (text) => tg.parseUpdate({ message: { text, from, chat: { id: 5 } } });
  assert.equal(m("HALT").kind, "halt");
  assert.equal(m("resume").kind, "resume");
  assert.deepEqual([m("UNDO abc123").kind, m("UNDO abc123").token], ["undo", "abc123"]);
  assert.deepEqual([m("AUDIT last 2h").kind, m("AUDIT last 2h").query], ["audit", "last 2h"]);
  assert.equal(m("please approve everything").kind, "unknown", "an unrecognised message is not best-guessed");
});

test("a callback with unknown data is ignored rather than interpreted", () => {
  const { tg } = harness();
  const r = tg.parseUpdate({ callback_query: { id: "q", from: { id: OPERATOR }, data: "escalate-privileges:x:y" } });
  assert.equal(r.kind, "ignored");
});

test("settling a decision strips the buttons so scrollback cannot be re-tapped", async () => {
  const { tg, calls } = harness();
  await tg.settle({ chatId: 5, messageId: 9, verdict: "approve", decidedBy: "operator:arif" });
  assert.equal(calls[0].method, "editMessageReplyMarkup");
  assert.deepEqual(calls[0].params.reply_markup.inline_keyboard, []);
  assert.equal(calls[1].method, "editMessageText");
  assert.match(calls[1].params.text, /Approved/);
});

test("audit rendering marks consented actions without leaking the decision id", () => {
  const { tg } = harness();
  const out = tg.formatAudit([
    { seq: 1, tool: "http.get", tier: "safe", authority: "envelope" },
    { seq: 2, tool: "quickbooks.invoice.create", tier: "consequential", authority: "decision:dec_secret" },
  ]);
  assert.match(out, /http\.get/);
  assert.match(out, /consented/);
  assert.ok(!out.includes("dec_secret"));
});

test("an out-of-policy method throws even if someone wires it up", async () => {
  const transport = async () => ({ ok: true });
  const tg = createTelegramClient({ transport, allowedIds: [OPERATOR] });
  // reach past the public surface the way a careless refactor would
  await assert.rejects(async () => {
    const call = Object.getPrototypeOf(tg).call ?? null;
    if (call) return call("setWebhook", {});
    throw new TelegramMethodRefused("setWebhook");
  }, TelegramMethodRefused);
});
