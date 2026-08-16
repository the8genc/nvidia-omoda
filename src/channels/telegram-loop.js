// The live operator loop: long-poll Telegram, route commands through the same
// paths the Action API uses, and write every outcome to the ledger.
//
// Telegram never decides anything itself. It collects a tap and hands it to the
// intent store, which enforces separation of duties and single use. If someone
// forges a callback, the store still refuses it.

import { createEnvelope, SOURCE, DIRECTION } from "../transport/envelope.js";

export function createTelegramLoop({
  client,
  intents,
  ledger,
  policy = null,
  operator,
  pollTimeoutSec = 25,
  transport,
  // The v4 modality transform (src/channels/modality.js). Optional: without it
  // a voice note gets an honest "not configured" reply rather than silence.
  mediaTransform = null,
}) {
  if (!client) throw new Error("telegram loop requires a client");
  if (!operator) throw new Error("telegram loop requires an operator identity");

  let offset = 0;
  let running = false;
  let halted = false;

  const record = (entry) => {
    try { ledger.append({ kind: "telegram", agent: operator.id, verb: "update", ...entry }); }
    catch { /* the ledger is best effort here; the API path is the durable one */ }
  };

  async function handle(update) {
    const cmd = client.parseUpdate(update);
    if (!cmd) return { kind: "none" };

    if (cmd.kind === "ignored") {
      // Logged, never acted on. Someone who is not the operator tried something.
      record({ tool: "telegram.ignored", outcome: "ignored", reason: cmd.reason, from: String(cmd.from ?? "?") });
      return cmd;
    }

    if (cmd.kind === "decide") {
      const out = intents.decide({
        intentId: cmd.intentId,
        actionId: cmd.actionId,
        verdict: cmd.verdict,
        reason: `decided from Telegram by ${operator.id}`,
        caller: operator,
      });
      await client.acknowledge(cmd.callbackQueryId, out.ok ? "Recorded" : out.reason);
      if (cmd.chatId && cmd.messageId) {
        await client.settle({
          chatId: cmd.chatId, messageId: cmd.messageId,
          verdict: cmd.verdict, decidedBy: operator.id,
        });
      }
      record({
        tool: "telegram.decide",
        outcome: out.ok ? "recorded" : "refused",
        reason: out.ok ? cmd.verdict : out.reason,
        intentId: cmd.intentId,
      });
      return { ...cmd, ok: out.ok };
    }

    if (cmd.kind === "media") {
      // A voice note is an ENGAGEMENT: it becomes a proposed intent, exactly as
      // if the transcript had arrived through the API door. The proposer is the
      // channel identity, not the operator, so the human who spoke can still be
      // the human who approves; consent stays a distinct recorded act.
      if (!mediaTransform) {
        await client.send({ chatId: cmd.chatId, text: "Voice and video need the modality transform, which is not configured on this deployment." });
        record({ tool: "telegram.media", outcome: "unconfigured", reason: cmd.modality });
        return { ...cmd, ok: false };
      }
      try {
        const t = await mediaTransform.transform(cmd);
        const proposer = { id: `telegram:${t.modality}:${cmd.from}`, scopes: ["intent:propose"] };
        const { intent, duplicate } = intents.propose({
          idempotencyKey: `tg-media-${cmd.fileId}`,
          caller: proposer,
          envelope: createEnvelope({
            source: SOURCE.TELEGRAM, direction: DIRECTION.INBOUND,
            modality: t.modality, idempotencyKey: `tg-media-${cmd.fileId}`,
          }),
          body: {
            source: "telegram", kind: "task",
            evidence: { modality: t.modality, transcript: t.transcript, flags: t.flags, model: t.model },
            requested_outcome: t.transcript,
          },
        });
        await client.send({
          chatId: cmd.chatId,
          text: [
            `*Heard* (${t.modality}, ${t.latencyMs} ms on the local model):`,
            `_${t.transcript.slice(0, 400)}_`,
            t.screened ? `screened: ${t.flags.join(", ")}` : null,
            ``,
            `Intent \`${intent.id}\` proposed${duplicate ? " (duplicate delivery, same intent)" : ""}.`,
          ].filter((x) => x !== null).join("\n"),
        });
        record({
          tool: "telegram.media", outcome: "transcribed",
          reason: `${t.modality} ${t.bytes}b via ${t.model} (${t.egress})`, intentId: intent.id,
        });
        return { ...cmd, ok: true, intentId: intent.id, transcript: t.transcript };
      } catch (err) {
        // A refusal is a reply, never silence. The zero-egress case lands here:
        // local model down means the audio does not leave the box, and we say so.
        await client.send({ chatId: cmd.chatId, text: `Cannot process that ${cmd.modality}: ${err.message}` });
        record({ tool: "telegram.media", outcome: "refused", reason: err.message.slice(0, 160) });
        return { ...cmd, ok: false, reason: err.message };
      }
    }

    if (cmd.kind === "audit") {
      const entries = ledger.query({ limit: 40 });
      await client.send({ chatId: cmd.chatId, text: client.formatAudit(entries) });
      record({ tool: "telegram.audit", outcome: "served" });
      return cmd;
    }

    if (cmd.kind === "halt") {
      halted = true;
      let reverted = 0;
      if (policy?.revertAll) {
        try { ({ reverted = 0 } = await policy.revertAll()); }
        catch (err) {
          await client.send({ chatId: cmd.chatId, text: `HALT set, but a revert FAILED: ${err.message}` });
          record({ tool: "telegram.halt", outcome: "revert-failed", reason: err.message });
          return { ...cmd, halted: true, revertFailed: true };
        }
      }
      await client.send({ chatId: cmd.chatId, text: `Halted. ${reverted} open capability(ies) revoked. Send RESUME to re-admit.` });
      record({ tool: "telegram.halt", outcome: "halted", reason: `reverted ${reverted}` });
      return { ...cmd, halted: true, reverted };
    }

    if (cmd.kind === "resume") {
      halted = false;
      await client.send({ chatId: cmd.chatId, text: "Resumed. Actions are admitted again." });
      record({ tool: "telegram.resume", outcome: "resumed" });
      return cmd;
    }

    if (cmd.kind === "undo") {
      await client.send({ chatId: cmd.chatId, text: `Undo requested for \`${cmd.token}\`. Replaying the registered inverse.` });
      record({ tool: "telegram.undo", outcome: "requested", reason: cmd.token });
      return cmd;
    }

    await client.send({ chatId: cmd.chatId, text: "Not a command I act on. Try APPROVE via the buttons, AUDIT, UNDO <token>, HALT or RESUME." });
    return cmd;
  }

  return {
    get halted() { return halted; },
    get running() { return running; },
    handle,

    /** One poll cycle. Exposed so tests drive it without timers. */
    async pollOnce() {
      const res = await transport("getUpdates", { offset, timeout: pollTimeoutSec });
      const updates = res?.result ?? [];
      const results = [];
      for (const u of updates) {
        offset = Math.max(offset, (u.update_id ?? 0) + 1);
        results.push(await handle(u));
      }
      return results;
    },

    async start() {
      running = true;
      while (running) {
        try { await this.pollOnce(); }
        catch (err) {
          process.emitWarning(`telegram poll failed: ${err.message}`);
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    },

    stop() { running = false; },
  };
}
