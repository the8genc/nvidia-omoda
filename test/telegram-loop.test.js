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
