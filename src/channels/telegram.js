// Telegram operator channel.
//
// Telegram is a CLIENT of the Action API, not the interface. It notifies, it
// collects a one-tap decision, and it writes that decision back through the API
// so the ledger stays the record. If Telegram is down the platform is unaffected.
//
// The transport is injected, so everything here is testable without a bot token
// and without touching the network. Only live sending needs the token.
//
// Method surface is deliberately narrow and matches policies/omoda-telegram.yaml:
//   getUpdates, sendMessage, answerCallbackQuery, editMessageText,
//   editMessageReplyMarkup, getMe
// setWebhook is absent. An agent that could call it could redirect the approval
// channel and forge its own decisions.

const ALLOWED_METHODS = new Set([
  "getUpdates", "sendMessage", "answerCallbackQuery",
  "editMessageText", "editMessageReplyMarkup", "getMe",
  // getFile resolves a voice note for the v4 modality transform. The download
  // itself is GET /file/bot*/** on the same host; both are in the policy.
  "getFile",
]);

export class TelegramMethodRefused extends Error {
  constructor(method) {
    super(`refusing telegram method ${method}: outside the hardened policy`);
    this.name = "TelegramMethodRefused";
  }
}

/** @param {(method:string, params:object) => Promise<object>} transport */
export function createTelegramClient({ transport, allowedIds = [], parseMode = "Markdown" } = {}) {
  if (typeof transport !== "function") throw new Error("telegram client requires a transport");
  const allowed = new Set(allowedIds.map(String));

  async function call(method, params = {}) {
    // Defence in depth: the network policy already excludes these, but a client
    // that can name them is one config mistake away from using them.
    if (!ALLOWED_METHODS.has(method)) throw new TelegramMethodRefused(method);
    return transport(method, params);
  }

  /** Only the registered operator may act. Everyone else is logged and ignored. */
  function isOperator(id) {
    return allowed.size > 0 && allowed.has(String(id));
  }

  function escalationText(intent, action) {
    const impact = (action.impact ?? []).join(", ") || "none";
    return [
      "*Consent required*",
      "",
      `\`${action.tool}\``,
      `verb: *${action.verb}*   impact: *${impact}*`,
      "",
      `intent: \`${intent.id}\``,
      intent.detector ? `detector: ${intent.detector}` : null,
      intent.requestedOutcome ? `outcome: ${intent.requestedOutcome}` : null,
      "",
      "The write method is absent from policy until you decide.",
    ].filter(Boolean).join("\n");
  }

  return {
    ALLOWED_METHODS,
    isOperator,

    async health() {
      const me = await call("getMe");
      return { ok: Boolean(me?.ok ?? me?.result), username: me?.result?.username ?? null };
    },

    /** Ask for a decision, with the two taps that matter. */
    async escalate({ chatId, intent, action }) {
      return call("sendMessage", {
        chat_id: chatId,
        text: escalationText(intent, action),
        parse_mode: parseMode,
        reply_markup: {
          inline_keyboard: [[
            { text: "Approve", callback_data: `approve:${intent.id}:${action.actionId}` },
            { text: "Deny", callback_data: `deny:${intent.id}:${action.actionId}` },
          ]],
        },
      });
    },

    /** Post-hoc notice for a contained write, with a way back. */
    async notifyUndo({ chatId, action, undoToken }) {
      return call("sendMessage", {
        chat_id: chatId,
        text: `Ran \`${action.tool}\` (${action.verb}, contained).\nUndo: \`UNDO ${undoToken}\``,
        parse_mode: parseMode,
      });
    },

    /** Strip the buttons once decided, so scrollback cannot be re-tapped. */
    async settle({ chatId, messageId, verdict, decidedBy }) {
      await call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
      return call("editMessageText", {
        chat_id: chatId, message_id: messageId, parse_mode: parseMode,
        text: `*${verdict === "approve" ? "Approved" : "Denied"}* by ${decidedBy}.`,
      });
    },

    async acknowledge(callbackQueryId, text) {
      return call("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
    },

    async send({ chatId, text }) {
      return call("sendMessage", { chat_id: chatId, text, parse_mode: parseMode });
    },

    /**
     * Parse an update into an operator command. Returns null for anything we do
     * not act on, so an unknown message is inert rather than best-guessed.
     */
    parseUpdate(update = {}) {
      const cq = update.callback_query;
      if (cq) {
        const from = cq.from?.id;
        if (!isOperator(from)) return { kind: "ignored", reason: "not the registered operator", from };
        const [verdict, intentId, actionId] = String(cq.data ?? "").split(":");
        if (verdict !== "approve" && verdict !== "deny") return { kind: "ignored", reason: "unknown callback" };
        return {
          kind: "decide", verdict, intentId, actionId,
          callbackQueryId: cq.id, chatId: cq.message?.chat?.id, messageId: cq.message?.message_id, from,
        };
      }

      const msg = update.message;
      if (!msg) return null;
      const from = msg.from?.id;

      // Media before text: a voice note has no .text, and it is an engagement,
      // not a command. Modality is detected here; the transform happens in the
      // loop, which holds the inference client.
      if (!msg.text) {
        const media = msg.voice ?? msg.audio ?? msg.video_note ?? msg.video;
        if (!media) return null;
        if (!isOperator(from)) return { kind: "ignored", reason: "not the registered operator", from };
        const modality = (msg.voice || msg.audio) ? "voice" : "video";
        return {
          kind: "media", modality,
          fileId: media.file_id, mimeType: media.mime_type ?? null, duration: media.duration ?? null,
          chatId: msg.chat?.id, from,
        };
      }

      if (!isOperator(from)) return { kind: "ignored", reason: "not the registered operator", from };

      const text = msg.text.trim();
      const chatId = msg.chat?.id;
      if (/^HALT$/i.test(text)) return { kind: "halt", chatId, from };
      if (/^RESUME$/i.test(text)) return { kind: "resume", chatId, from };
      const undo = text.match(/^UNDO\s+(\S+)$/i);
      if (undo) return { kind: "undo", token: undo[1], chatId, from };
      const audit = text.match(/^AUDIT(?:\s+(.*))?$/i);
      if (audit) return { kind: "audit", query: (audit[1] ?? "").trim(), chatId, from };
      return { kind: "unknown", text, chatId, from };
    },

    /** Render an AUDIT reply from ledger rows. */
    formatAudit(entries) {
      if (entries.length === 0) return "No actions recorded in that window.";
      const lines = entries.slice(-20).map((e) => {
        const auth = String(e.authority ?? "-").startsWith("decision:") ? "consented" : (e.authority ?? "-");
        return `\`${String(e.seq).padStart(3)}\` ${e.tool ?? "-"} · ${e.tier ?? e.kind ?? "-"} · ${auth}`;
      });
      return ["*Recent actions*", ...lines].join("\n");
    },
  };
}

/** Live transport. Needs a bot token; the token is held by the gateway, not here. */
export function createHttpTransport({ token, baseUrl = "https://api.telegram.org", fetchImpl = fetch }) {
  if (!token) throw new Error("no telegram bot token configured");
  return async (method, params) => {
    const res = await fetchImpl(`${baseUrl}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    return res.json();
  };
}
