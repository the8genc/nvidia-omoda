#!/usr/bin/env node
// The three layers, end to end, against the live OpenClaw gateway.
//
//   node src/demo/three-layer.js                 # reads live, write gated (no upstream mutation)
//   node src/demo/three-layer.js --mutate        # also perform the upstream write, then undo it
//
// Layer 1  Paperclip's orchestration protocol. We speak its exact wire format:
//          protocol v4, ed25519 device identity, the same connect frame its
//          openclaw_gateway adapter sends.
// Layer 2  OMODA. Decides which of the gateway's 171 methods this agent may
//          reach, on what terms, and materialises the capability for the ones
//          that need a recorded human decision.
// Layer 3  The OpenClaw gateway and its OpenShell sandbox. The thing that
//          actually refuses.
//
// The gateway is another team's production service on a shared box. Reads run
// against it for real. The consequential write's POLICY LIFECYCLE is real and
// verified against the compiled envelope, but the upstream mutation is opt-in:
// scheduling a payload on someone else's runtime to make a demo look better is
// not a trade this system should be willing to make. --mutate performs it and
// removes it again.

import { WebSocket } from "ws";
import { readFileSync, existsSync } from "node:fs";
import { resolveDeviceIdentity, buildConnectParams, createGatewayClient } from "../gateway/openclaw.js";
import { loadSkills, buildCapabilityIndex, mergeFragments } from "../skills/load.js";
import { createSimulatedPolicy } from "../policy/envelope.js";
import { createLedger } from "../ledger/ledger.js";
import { authorize } from "../broker/authorize.js";
import { prohibitedReason } from "../domain/prohibited.js";
import { VERB, IMPACT } from "../domain/taxonomy.js";

if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}

const URL_ = process.env.OPENCLAW_GATEWAY_URL ?? "ws://127.0.0.1:18889";
const MUTATE = process.argv.includes("--mutate");

const c = {
  b: (s) => `\x1b[1m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, cy: (s) => `\x1b[36m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
};
const layer = (n, t) => console.log(`\n${c.b(`LAYER ${n}  ${t}`)}\n${c.dim("─".repeat(66))}`);
const step = (t) => console.log(`\n${c.b(t)}`);
const ok = (s) => console.log(`   ${c.g("OK")}  ${s}`);
const no = (s) => console.log(`   ${c.r("NO")}  ${s}`);
const info = (s) => console.log(`   ${c.dim(s)}`);

const { skills, errors } = loadSkills();
if (errors.length) throw new Error(`skills failed to compile: ${errors.map((e) => e.path).join(", ")}`);
const index = buildCapabilityIndex(skills);
const policy = createSimulatedPolicy(mergeFragments(skills));
const ledger = createLedger({ path: process.env.OMODA_LEDGER ?? `var/ledger/three-layer-${Math.floor(Date.now() / 1000)}.jsonl` });

const GW = { host: "host.openshell.internal", port: 18789, path: "/rpc" };
const decisionFor = (actionId, reason) => ({
  decisionId: `dec_three_layer_${actionId}`, actionId, verdict: "approve", reason,
  decidedBy: "operator:arif", proposedBy: "paperclip:orchestrator",
  scopes: ["intent:decide"], spent: false, settled: true, expiresAt: Date.now() + 120_000,
});

console.log(c.b("\nOMODA: three layers, against the live OpenClaw gateway\n"));

// ── LAYER 1: speak Paperclip's protocol to the gateway ────────────────────
layer(1, "Paperclip's protocol drives the gateway");
const identity = resolveDeviceIdentity({ keyPath: "var/device/openclaw-device.key" });
info(`device ${identity.deviceId.slice(0, 24)}… (${identity.source} key)`);
const gw = createGatewayClient({ url: URL_, WebSocketImpl: WebSocket });
await gw.open({ timeoutMs: 20000 });
const nonce = await gw.awaitChallenge({ timeoutMs: 20000 });
const hello = await gw.request("connect", buildConnectParams({
  nonce, identity, authToken: process.env.OPENCLAW_GATEWAY_TOKEN,
}), { timeoutMs: 20000 });
const methods = hello?.features?.methods ?? [];
ok(`connected: ${hello.type}, protocol ${hello.protocol}, server ${hello.server?.version}`);
info(`${methods.length} methods exposed. This is the surface Layer 2 has to govern.`);

/** Every gateway call goes through the Broker. Nothing calls the gateway directly. */
async function governed({ tool, verb, impact, method, params, label }) {
  const declared = index.lookup(tool);
  const actionId = `${tool}-${Date.now()}`;
  const action = {
    actionId, agent: "operator", tool, verb, impact,
    declared: Boolean(declared),
    request: { host: GW.host, method: verb === VERB.READ ? "GET" : "POST", path: GW.path },
    inverse: verb === VERB.CREATE ? { undo: "remove what was created" } : undefined,
  };
  return { action, declared, actionId, label, method, params };
}

// ── LAYER 2 + 3: a read runs unattended ───────────────────────────────────
layer(2, "OMODA governs. First, a read.");
{
  const g = await governed({
    tool: "openclaw.agents.list", verb: VERB.READ, impact: [], method: "agents.list", params: {},
  });
  info(`${g.action.tool}: verb=read, impact=[] → no consent required`);
  const out = await authorize(g.action, {
    ledger, policy,
    execute: async () => gw.request("agents.list", {}, { timeoutMs: 20000 }),
  });
  const agents = out.result?.agents ?? [];
  ok(`${out.status} with no human in the loop`);
  info(`live from the gateway: ${agents.length} agent(s) — ${agents.map((a) => a.id).join(", ") || "none"}`);
  info("this is real traffic to another team's runtime, and it needed nobody's permission");
}

// ── LAYER 2 + 3: a consequential write is absent from policy ──────────────
layer(2, "A write with a blast domain. The method does not exist yet.");
{
  const g = await governed({
    tool: "openclaw.cron.add", verb: VERB.CREATE, impact: [IMPACT.REPUTATIONAL],
    method: "cron.add", params: {},
  });
  const before = policy.check(g.action.request);
  no(`OpenShell: ${before.status} ${before.reason}`);
  info("scheduling work on shared hardware runs under our name when nobody is watching,");
  info("so cron.add compiles to GET only. The write method is absent, not merely refused.");

  const escalated = await authorize(g.action, { ledger, policy });
  ok(`Broker: ${escalated.status} — it cannot proceed, so it asks`);

  step("A recorded decision materialises the capability");
  const decision = decisionFor(g.actionId, "approved for the three-layer demonstration");
  let upstream = null;
  const done = await authorize(g.action, {
    ledger, policy, decision,
    execute: async () => {
      const during = policy.check(g.action.request);
      info(`during execution: ${during.status} — the method exists for this one call`);
      if (!MUTATE) {
        info(c.y("upstream call withheld: this is another team's gateway (--mutate to perform it)"));
        return { withheld: true };
      }
      const name = `omoda-demo-${Math.floor(Date.now() / 1000)}`;
      upstream = await gw.request("cron.add", {
        name, schedule: "0 0 1 1 *", sessionTarget: { agentId: "main" },
        payload: { kind: "text", text: "omoda three-layer demo, removed immediately" },
      }, { timeoutMs: 20000 }).catch((e) => ({ error: e.message }));
      return { created: name, upstream };
    },
  });
  ok(`${done.status} under authority ${c.cy(done.authority)}`);
  const after = policy.check(g.action.request);
  ok(`after revert: ${after.status} ${after.reason}`);
  info(`open deltas: ${JSON.stringify(policy.envelope?.openDeltas ?? [])}`);

  if (MUTATE && upstream && !upstream.error) {
    step("Undo, because a create carries its inverse");
    const jobs = await gw.request("cron.list", {}, { timeoutMs: 20000 });
    const mine = (jobs.jobs ?? []).filter((j) => String(j.name ?? "").startsWith("omoda-demo-"));
    for (const j of mine) {
      await gw.request("cron.remove", { id: j.id ?? j.name }, { timeoutMs: 20000 }).catch(() => {});
    }
    const left = await gw.request("cron.list", {}, { timeoutMs: 20000 });
    ok(`cleaned up: ${(left.jobs ?? []).length} job(s) remain on their gateway`);
  }
}

// ── LAYER 2: the self-protection clause ───────────────────────────────────
layer(2, "The one thing no human can approve");
{
  const tool = "openclaw.exec.approvals.set";
  const rule = prohibitedReason({ tool });
  info(`${tool} would turn off the gateway's own execution approvals.`);
  const action = {
    actionId: "prohibited-1", agent: "operator", tool,
    verb: VERB.UPDATE, impact: [IMPACT.LEGAL], declared: false,
    request: { host: GW.host, method: "POST", path: GW.path },
  };
  // Hand it a perfectly valid decision. It must still refuse.
  const decision = decisionFor("prohibited-1", "operator really did approve this");
  const out = await authorize(action, {
    ledger, policy, decision, execute: async () => ({ shouldNeverRun: true }),
  }).catch((err) => ({ status: "refused", reason: err.message }));
  no(`refused: ${out.reason ?? out.status} [rule: ${rule}]`);
  info("note the decision was valid. Prohibited is checked BEFORE consent, so there is");
  info("no tap that unlocks this. A consent path able to disable the consent mechanism");
  info("would be a privilege escalation ladder, not a control.");
}

// ── the trail ─────────────────────────────────────────────────────────────
layer("*", "What it wrote down");
for (const e of ledger.all().slice(-8)) {
  console.log(`   ${String(e.seq).padStart(3)} ${String(e.tool ?? "-").padEnd(26)} ${String(e.tier ?? e.kind ?? "-").padEnd(14)} ${e.outcome ?? e.authority ?? "-"}`);
}
ok(`chain: ${JSON.stringify(ledger.verify())}`);

gw.close();
console.log(`\n${c.b("Layer 1 drove it. Layer 2 decided. Layer 3 would have stopped it.")}\n`);
