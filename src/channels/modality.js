// The modality transform for the Telegram door (PRD 23.1, interface 3).
//
// A Telegram engagement arrives as text, voice, or video. This layer detects
// the modality and normalizes it, so nothing downstream knows or cares that a
// request was spoken rather than typed.
//
// Two properties are the point:
//
//   1. Zero egress. The audio is downloaded to the box and transcribed by the
//      LOCAL Omni. The route() call is what enforces it: perception requires the
//      local model, and if the local model is down the transform REFUSES rather
//      than sending an operator's voice to a hosted endpoint. A refusal is a
//      Telegram reply saying so, never a silent fallback.
//
//   2. A transcript is untrusted evidence. It passes the same S8 screen as a
//      camera detection before it can reach planner context, because a voice
//      note is still an input channel: anyone the allowlist admits can speak an
//      instruction-shaped sentence.

import { createHash } from "node:crypto";
import { route, TASK } from "../models/router.js";
import { stripReasoning } from "../models/client.js";
import { screenText } from "../models/screen.js";

/** What kind of thing is this Telegram message? */
export function detectModality(msg = {}) {
  if (typeof msg.text === "string") return { modality: "text" };
  const pick = (m, kind) => ({
    modality: kind,
    fileId: m.file_id,
    mimeType: m.mime_type ?? null,
    duration: m.duration ?? null,
  });
  if (msg.voice) return pick(msg.voice, "voice");
  if (msg.audio) return pick(msg.audio, "voice"); // an audio file is spoken input too
  if (msg.video_note) return pick(msg.video_note, "video");
  if (msg.video) return pick(msg.video, "video");
  return { modality: "unsupported" };
}

export class TransformRefused extends Error {
  constructor(message, { modality = null } = {}) {
    super(message);
    this.name = "TransformRefused";
    this.modality = modality;
  }
}

/**
 * @param {object} opts
 * @param {(method:string, params:object)=>Promise<object>} opts.transport the
 *   telegram transport (getFile goes through it, so the hardened method
 *   allowlist applies)
 * @param {string} opts.token bot token, for the file download URL only
 * @param {{complete:Function}} opts.inference the inference client
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {() => boolean} [opts.localAvailable]
 */
export function createModalityTransform({
  transport, token, inference,
  fetchImpl = globalThis.fetch,
  baseUrl = "https://api.telegram.org",
  localAvailable = () => true,
  maxBytes = 20 * 1024 * 1024, // Telegram's own getFile ceiling
  now = () => Date.now(),
} = {}) {
  if (typeof transport !== "function") throw new Error("modality transform requires the telegram transport");
  if (!inference) throw new Error("modality transform requires an inference client");
  if (!token) throw new Error("modality transform requires the bot token for file downloads");

  async function download(fileId) {
    const meta = await transport("getFile", { file_id: fileId });
    const filePath = meta?.result?.file_path;
    if (!filePath) throw new TransformRefused("telegram getFile returned no file path");
    const res = await fetchImpl(`${baseUrl}/file/bot${token}/${filePath}`);
    if (!res.ok) throw new TransformRefused(`file download failed: HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > maxBytes) throw new TransformRefused(`file too large: ${bytes.length} bytes`);
    return bytes;
  }

  /**
   * Voice (or audio) to screened transcript. Throws TransformRefused when the
   * local model is unavailable: the audio must not leave the box.
   */
  async function transcribe({ fileId, mimeType = "audio/ogg", modality = "voice" }) {
    // The routing decision IS the zero-egress guarantee. PERCEIVE with the
    // local model down throws RoutingRefused before any bytes move.
    const decision = route({ task: TASK.PERCEIVE, payload: "", multimodal: true, localAvailable: localAvailable() });

    const started = now();
    const bytes = await download(fileId);
    const out = await inference.complete({
      model: decision.model,
      endpoint: decision.endpoint,
      messages: [{
        role: "user",
        content: [
          { type: "audio_url", audio_url: { url: `data:${mimeType};base64,${bytes.toString("base64")}` } },
          { type: "text", text: "Transcribe this voice message verbatim. Reply with only the transcript, nothing else." },
        ],
      }],
      maxTokens: 500,
    });

    const rawTranscript = stripReasoning(out.text).trim();
    if (!rawTranscript) throw new TransformRefused("the model returned an empty transcript", { modality });

    // S8: a transcript is untrusted evidence, screened like any other.
    const { clean, flags } = screenText(rawTranscript);

    return {
      modality,
      transcript: clean,
      flags,
      screened: flags.length > 0,
      model: out.model,
      endpoint: out.endpoint,
      egress: decision.egress, // "local", asserted by tests
      bytes: bytes.length,
      contentKey: createHash("sha256").update(bytes).digest("hex").slice(0, 24),
      latencyMs: now() - started,
    };
  }

  /**
   * The single entry point the loop calls for any media message.
   * Video is detected and labeled from day one; the describe path is staged
   * (build plan cut list), and saying so beats pretending.
   */
  async function transform(detected) {
    if (detected.modality === "voice") return transcribe(detected);
    if (detected.modality === "video") {
      throw new TransformRefused(
        "video is detected and labeled, and its transform is staged; send a voice note or text for now",
        { modality: "video" },
      );
    }
    throw new TransformRefused(`unsupported modality; send text, a voice note, or video`, { modality: detected.modality });
  }

  return { detectModality, download, transcribe, transform };
}
