#!/usr/bin/env node
// Bring the platform up and leave it up, with one escalation pending.
//
//   npm run serve:live
//
// Unlike demo:live this does not exit. The Telegram loop keeps polling, so a tap
// lands whenever the operator gets to it, and the outcome is printed here.

import { boot } from "../boot.js";
import { authorize } from "../broker/authorize.js";
import { signEvent } from "../api/stream.js";
import { VERB, IMPACT } from "../domain/taxonomy.js";

const CHAT = process.env.TELEGRAM_CHAT_ID;
const QB = "quickbooks.api.intuit.com";
const PATH = "/v3/company/42/invoice";

const sys = await boot({
  port: Number(process.env.OMODA_PORT ?? 3110),
  streamPort: Number(process.env.OMODA_STREAM_PORT ?? 3111),
  print: true,
});

if (!sys.telegram) {
  console.error("telegram loop is not running; check TELEGRAM_ALLOWED_IDS");
  process.exit(1);
}

const ts = Math.floor(Date.now() / 1000);
const payload = {
  kind: "detection", detector: "traffic-anomaly", class: "stopped-vehicle", camera: "cam3",
  confidence: 0.94,
  evidence: { frame_ref: "s3://frames/cam3/" + ts + ".jpg", caption: "stopped vehicle blocking lane" },
  requested_outcome: "raise the incident callout invoice",
};
const raw = JSON.stringify({
  event_id: `cam3-${ts}`, ts, sig: signEvent(sys.see.secret, `cam3-${ts}`, ts, payload), payload,
});
const gate = sys.ingest.accept({ headers: { authorization: `Bearer ${sys.see.token}` } });
const ingested = sys.ingest.ingest(raw, gate.caller);

const action = {
  actionId: `act-${ts}`, agent: "finance", tool: "quickbooks.invoice.create",
  verb: VERB.CREATE, impact: [IMPACT.FINANCIAL], declared: true,
  request: { host: QB, method: "POST", path: PATH },
};

const before = sys.policy.check(action.request);
console.log(`  policy before consent: ${before.status} (${before.reason})`);
await authorize(action, { ledger: sys.ledger, policy: sys.policy });

sys.intents.awaitConsent(ingested.intentId, { actionId: action.actionId });
await sys.telegramClient.escalate({
  chatId: CHAT, intent: sys.intents.get(ingested.intentId), action,
});
console.log(`\n  escalation sent to Telegram. Intent ${ingested.intentId}`);
console.log("  the loop stays up: tap whenever, the outcome prints here.");
console.log("  Ctrl-C to stop.\n");

let done = false;
setInterval(async () => {
  if (done) return;
  const d = sys.intents.get(ingested.intentId)?.decisions?.[0];
  if (!d) return;
  done = true;
  console.log(`\n  DECISION: ${d.verdict} by ${d.decidedBy}`);
  if (d.verdict !== "approve") {
    console.log(`  denied. policy still: ${sys.policy.check(action.request).status}\n`);
    return;
  }
  const out = await authorize(action, {
    ledger: sys.ledger, policy: sys.policy, decision: d,
    execute: async () => {
      console.log(`  during execution: ${sys.policy.check(action.request).status}`);
      return { ok: true, invoice: `INV-${ts}` };
    },
  });
  console.log(`  executed under ${out.authority}`);
  console.log(`  after revert:     ${sys.policy.check(action.request).status}`);
  console.log(`  open deltas:      ${JSON.stringify(sys.policy.envelope?.openDeltas ?? [])}`);
  await sys.telegramClient.send({
    chatId: CHAT,
    text: "Done. Capability was created for one call and revoked. Send *AUDIT* for the trail.",
  });
  console.log("  confirmation sent. Send AUDIT in Telegram to see the ledger.\n");
}, 1000);
