// Server-side rendered React. No JSX, so there is no build step and no client
// bundle: Node runs this file as-is and ships plain HTML.
//
// renderToStaticMarkup rather than renderToString because nothing here needs to
// hydrate. The decide action is a normal form POST handled on the server, which
// also means the operator's credential never reaches the browser.

import { createElement as h, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const CSS = `
:root{--bg:#0f1115;--panel:#171a21;--line:#252a34;--fg:#e6e9ef;--dim:#8b94a7;
--ok:#3fb950;--warn:#d29922;--bad:#f85149;--acc:#58a6ff;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif}
header{border-bottom:1px solid var(--line);padding:14px 22px;display:flex;gap:22px;align-items:baseline}
header h1{font-size:15px;margin:0;letter-spacing:.02em}
header nav a{color:var(--dim);text-decoration:none;margin-right:16px}
header nav a.on,header nav a:hover{color:var(--acc)}
main{padding:22px;max-width:1180px}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin:26px 0 10px}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden}
th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);
padding:9px 12px;border-bottom:1px solid var(--line);font-weight:600}
td{padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:none}
code,.mono{font-family:var(--mono);font-size:12px}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:600;border:1px solid}
.pill.ok{color:var(--ok);border-color:#1c3f26;background:#0d1f13}
.pill.warn{color:var(--warn);border-color:#463a12;background:#221a06}
.pill.bad{color:var(--bad);border-color:#4a1f1d;background:#25100f}
.pill.dim{color:var(--dim);border-color:var(--line);background:#12151b}
.empty{color:var(--dim);padding:16px;background:var(--panel);border:1px dashed var(--line);border-radius:8px}
form.inline{display:flex;gap:8px;align-items:center;margin:0}
input[type=text]{background:#0c0e12;border:1px solid var(--line);color:var(--fg);
padding:6px 9px;border-radius:6px;font-size:12px;min-width:250px;font-family:inherit}
textarea,select{background:#0c0e12;border:1px solid var(--line);color:var(--fg);
padding:8px 10px;border-radius:6px;font-size:12px;font-family:var(--mono);width:100%}
form.stack{display:flex;flex-direction:column;gap:12px;max-width:760px;background:var(--panel);
border:1px solid var(--line);border-radius:8px;padding:18px}
form.stack label{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);font-weight:600}
.err{color:var(--bad);background:#25100f;border:1px solid #4a1f1d;border-radius:8px;padding:10px 14px;font-size:12px}
.okbox{color:var(--ok);background:#0d1f13;border:1px solid #1c3f26;border-radius:8px;padding:10px 14px;font-size:12px}
button{background:#1f6feb;border:0;color:#fff;padding:6px 12px;border-radius:6px;font-size:12px;
font-weight:600;cursor:pointer}
button.deny{background:#3a1d1c;color:var(--bad)}
.note{color:var(--dim);font-size:12px;margin:6px 0 0}
`;

const pill = (text, kind = "dim") => h("span", { className: `pill ${kind}` }, text);

function Layout({ title, active, children }) {
  return h("html", { lang: "en" },
    h("head", null,
      h("meta", { charSet: "utf-8" }),
      h("meta", { name: "viewport", content: "width=device-width,initial-scale=1" }),
      h("title", null, `OMODA ${title}`),
      h("style", { dangerouslySetInnerHTML: { __html: CSS } }),
    ),
    h("body", null,
      h("header", null,
        h("h1", null, "OMODA"),
        h("nav", null,
          h("a", { href: "/ui", className: active === "skills" ? "on" : "" }, "Skills"),
          h("a", { href: "/ui/intents", className: active === "intents" ? "on" : "" }, "Intents"),
          h("a", { href: "/ui/ledger", className: active === "ledger" ? "on" : "" }, "Ledger"),
          h("a", { href: "/ui/agents/new", className: active === "deploy" ? "on" : "" }, "Deploy agent"),
          h("a", { href: "/ui/knowledge", className: active === "knowledge" ? "on" : "" }, "Knowledge"),
          h("a", { href: "/ui/triggers", className: active === "triggers" ? "on" : "" }, "Triggers"),
        ),
      ),
      h("main", null, children),
    ),
  );
}

const consentPill = (consent) =>
  consent === "none" ? pill("autonomous", "ok")
    : consent === "two-person" ? pill("two-person", "bad")
      : pill(consent, "warn");

export function SkillsPage({ skills, deployed = null }) {
  return h(Layout, { title: "skills", active: "skills" },
    deployed ? h("div", { className: "okbox" },
      `Agent "${deployed}" deployed. If you chose apply-now the service is restarting and this page reflects it in a few seconds; otherwise it applies on the next restart.`) : null,
    h("h2", null, "Enabled skills"),
    skills.length === 0
      ? h("div", { className: "empty" }, "No skills enabled.")
      : h(Fragment, null, skills.map((s) =>
        h("div", { key: s.skill, style: { marginBottom: 26 } },
          h("h2", null, `${s.skill}  `, pill(s.agent, "dim")),
          h("table", null,
            h("thead", null, h("tr", null,
              ["Tool", "Verb", "Impact", "OpenShell grant", "Consent"].map((c) => h("th", { key: c }, c)),
            )),
            h("tbody", null, s.registry.map((r) =>
              h("tr", { key: r.tool },
                h("td", { className: "mono" }, r.tool),
                h("td", null, r.verb),
                h("td", null, r.impact.length ? r.impact.map((i) => h("span", { key: i }, pill(i, "warn"), " ")) : h("span", { className: "mono" }, "-")),
                h("td", { className: "mono" }, r.grant),
                h("td", null, consentPill(r.consent)),
              ),
            )),
          ),
          h("p", { className: "note" },
            "Compiled from the manifest. A write carrying impact grants GET only; the write method appears solely while a decision is live."),
        ),
      )),
  );
}

export function IntentsPage({ intents, csrf }) {
  const pending = intents.filter((i) => i.state === "awaiting_consent" || i.state === "proposed");
  return h(Layout, { title: "intents", active: "intents" },
    h("h2", null, "Intents"),
    pending.length === 0
      ? h("div", { className: "empty" }, "Nothing awaiting a decision.")
      : h("table", null,
        h("thead", null, h("tr", null,
          ["Intent", "Source", "Detector", "Requested", "State", "Decide"].map((c) => h("th", { key: c }, c)),
        )),
        h("tbody", null, pending.map((i) =>
          h("tr", { key: i.id },
            h("td", { className: "mono" }, i.id.slice(0, 14)),
            h("td", null, i.proposedBy),
            h("td", null, i.detector ?? "-"),
            h("td", null, i.requestedOutcome ?? "-"),
            h("td", null, i.state === "awaiting_consent" ? pill("awaiting consent", "warn") : pill(i.state, "dim")),
            h("td", null,
              h("form", { className: "inline", method: "POST", action: "/ui/decide" },
                h("input", { type: "hidden", name: "csrf", value: csrf }),
                h("input", { type: "hidden", name: "intent_id", value: i.id }),
                h("input", { type: "hidden", name: "action_id", value: i.actions[0]?.actionId ?? "act-1" }),
                h("input", { type: "text", name: "reason", placeholder: "reason (required)", required: true }),
                h("button", { type: "submit", name: "verdict", value: "approve" }, "Approve"),
                h("button", { type: "submit", name: "verdict", value: "deny", className: "deny" }, "Deny"),
              ),
            ),
          ),
        )),
      ),
    h("p", { className: "note" },
      "A decision is recorded against one action and expires. The proposer cannot decide its own intent."),
  );
}

export function LedgerPage({ entries, chain }) {
  return h(Layout, { title: "ledger", active: "ledger" },
    h("h2", null, "Action ledger  ",
      chain.ok ? pill(`chain verifies, ${chain.length} entries`, "ok") : pill(`chain broken at ${chain.brokenAt}`, "bad")),
    entries.length === 0
      ? h("div", { className: "empty" }, "No actions recorded yet.")
      : h("table", null,
        h("thead", null, h("tr", null,
          ["#", "Agent", "Tool", "Verb", "Tier", "Authority", "Outcome"].map((c) => h("th", { key: c }, c)),
        )),
        h("tbody", null, entries.slice().reverse().map((e) =>
          h("tr", { key: e.seq },
            h("td", { className: "mono" }, e.seq),
            h("td", null, e.agent ?? "-"),
            h("td", { className: "mono" }, e.tool ?? "-"),
            h("td", null, e.verb ?? "-"),
            h("td", null,
              e.tier === "prohibited" ? pill("prohibited", "bad")
                : e.tier === "consequential" ? pill("consequential", "warn")
                  : pill(e.tier ?? e.kind ?? "-", "dim")),
            h("td", { className: "mono" }, String(e.authority ?? "-").slice(0, 34)),
            h("td", null, e.outcome ?? "-"),
          ),
        )),
      ),
    h("p", { className: "note" },
      "Written and fsynced before each action runs, so a crash between deciding and acting still leaves evidence."),
  );
}

const LEVELS = [
  ["0", "L0 orchestrator: reasons over every request, holds inference, no tools"],
  ["1", "L1 domain expert: domain-scoped inference, directs its L2s, no tools"],
  ["2", "L2 worker (default): tools for non-dangerous work, NO inference"],
  ["3", "L3 tool specialist: pure connectivity, no inference, no task context"],
];

const CAPS_PLACEHOLDER = `- tool: example.records.read
  verb: read
  impact: []
  egress: { host: api.example.com, path: "/v1/records/**" }
- tool: example.records.create
  verb: create
  impact: [financial]
  egress: { host: api.example.com, path: "/v1/records" }`;

export function AgentNewPage({ csrf, error = null, prefill = {} }) {
  const val = (k, d = "") => prefill[k] ?? d;
  return h(Layout, { title: "deploy agent", active: "deploy" },
    h("h2", null, "Deploy a new agent"),
    h("p", { className: "note" },
      "This writes one omoda.skill.md and nothing else. The compiler is the only writer of policy: ",
      "the manifest below is its only input, so the agent gets exactly what it declares. ",
      "Writes carrying impact compile to GET-only until a recorded decision; an over-leveled manifest refuses to deploy."),
    error ? h("div", { className: "err" }, error) : null,
    h("form", { className: "stack", method: "POST", action: "/ui/agents/new" },
      h("input", { type: "hidden", name: "csrf", value: csrf }),
      h("label", null, "Skill name (kebab-case, becomes skills/<name>/)"),
      h("input", { type: "text", name: "skill", required: true, placeholder: "invoice-chaser", defaultValue: val("skill") }),
      h("label", null, "Agent name (kebab-case, the domain identity)"),
      h("input", { type: "text", name: "agent", required: true, placeholder: "finance", defaultValue: val("agent") }),
      h("label", null, "Level"),
      h("select", { name: "level", defaultValue: val("level", "2") },
        LEVELS.map(([v, t]) => h("option", { key: v, value: v }, t))),
      h("label", null, "Inference grant (levels 0 and 1 only; refused otherwise)"),
      h("select", { name: "inference", defaultValue: val("inference", "no") },
        h("option", { value: "no" }, "no"),
        h("option", { value: "yes" }, "yes")),
      h("label", null, "Description (one line)"),
      h("input", { type: "text", name: "description", placeholder: "Chases overdue invoices", defaultValue: val("description") }),
      h("label", null, "Capabilities (YAML list; levels 0 and 1 leave this empty)"),
      h("textarea", { name: "capabilities", rows: 10, placeholder: CAPS_PLACEHOLDER, defaultValue: val("capabilities") }),
      h("label", null, "Instructions (prose the agent reads; becomes the md body)"),
      h("textarea", { name: "instructions", rows: 6, placeholder: "What this agent is for, and how it should behave.", defaultValue: val("instructions") }),
      h("label", null,
        h("input", { type: "checkbox", name: "apply_now", value: "yes", style: { width: "auto", marginRight: 8 } }),
        " apply now (restarts the service so the agent is live immediately)"),
      h("button", { type: "submit" }, "Deploy agent"),
    ),
    h("p", { className: "note" },
      "Every deploy is ledgered. Levels are enforced at compile time: an L2 cannot hold inference, an L3 cannot do local work."),
  );
}

export function KnowledgePage({ csrf, docs = [], backend = "lexical", error = null, added = null }) {
  return h(Layout, { title: "knowledge", active: "knowledge" },
    h("h2", null, "Knowledge (the proxy layer's retrieval store)  ",
      backend.startsWith("nemotron") ? pill("NeMo Retriever embeddings, on-box", "ok") : pill(backend, "warn")),
    h("p", { className: "note" },
      "Documents uploaded here are retrieved as context for L1 domain inference. ",
      "Embedded by nvidia/llama-nemotron-embed-1b-v2 on the box when it is up; term scoring otherwise, and the badge says which."),
    error ? h("div", { className: "err" }, error) : null,
    added ? h("div", { className: "okbox" }, `Stored "${added.name}": ${added.chunks} chunk(s) via ${added.backend}${added.duplicate ? " (already known)" : ""}.`) : null,
    h("form", { className: "stack", method: "POST", action: "/ui/knowledge" },
      h("input", { type: "hidden", name: "csrf", value: csrf }),
      h("label", null, "Document name"),
      h("input", { type: "text", name: "name", required: true, placeholder: "incident-runbook-v2" }),
      h("label", null, "Content (paste the text; it is chunked, embedded and ledgered)"),
      h("textarea", { name: "text", rows: 10, required: true, placeholder: "Paste the document text here." }),
      h("button", { type: "submit" }, "Add to knowledge"),
    ),
    docs.length === 0
      ? h("div", { className: "empty", style: { marginTop: 18 } }, "No documents yet.")
      : h("table", { style: { marginTop: 18 } },
        h("thead", null, h("tr", null, ["Name", "Chunks", "Backend", "Added"].map((c) => h("th", { key: c }, c)))),
        h("tbody", null, docs.map((d) =>
          h("tr", { key: d.id },
            h("td", null, d.name),
            h("td", { className: "mono" }, d.chunks),
            h("td", null, d.backend?.startsWith("nemotron") ? pill("nemotron-embed", "ok") : pill(d.backend ?? "lexical", "dim")),
            h("td", { className: "mono" }, (d.addedAt ?? "").slice(0, 19)),
          ),
        )),
      ),
  );
}

export function TriggersPage({ csrf, rules = [], l1Agents = [], error = null, added = null }) {
  return h(Layout, { title: "triggers", active: "triggers" },
    h("h2", null, "Take-action triggers  ", pill(`${rules.length} rule(s)`, "dim")),
    h("p", { className: "note" },
      "L0 checks every observation's text against these phrases first, deterministically. ",
      "A hit routes straight to the named L1 agent, no inference. Text that matches nothing ",
      "and shows no other signal is ignored; anything ambiguous goes to the model to infer."),
    error ? h("div", { className: "err" }, error) : null,
    added ? h("div", { className: "okbox" }, `Added a trigger for "${added}".`) : null,
    rules.length === 0
      ? h("div", { className: "empty" }, "No triggers configured.")
      : h("table", null,
        h("thead", null, h("tr", null, ["Phrases", "Incident", "Routes to (L1)", "Action", ""].map((c) => h("th", { key: c }, c)))),
        h("tbody", null, rules.map((r) =>
          h("tr", { key: r.id },
            h("td", null, r.phrases.map((p) => h("span", { key: p }, pill(p, "warn"), " "))),
            h("td", { className: "mono" }, r.incidentType),
            h("td", null, pill(r.l1, "dim")),
            h("td", null, r.action || "-"),
            h("td", null,
              h("form", { className: "inline", method: "POST", action: "/ui/triggers/delete" },
                h("input", { type: "hidden", name: "csrf", value: csrf }),
                h("input", { type: "hidden", name: "id", value: r.id }),
                h("button", { type: "submit", className: "deny" }, "Remove"))),
          ),
        )),
      ),
    h("h2", { style: { marginTop: 28 } }, "Add a trigger"),
    h("form", { className: "stack", method: "POST", action: "/ui/triggers" },
      h("input", { type: "hidden", name: "csrf", value: csrf }),
      h("label", null, "Phrases (comma-separated; a match on any routes to the L1 below)"),
      h("input", { type: "text", name: "phrases", required: true, placeholder: "overturned, rollover, vehicle on its side" }),
      h("label", null, "Incident type"),
      h("input", { type: "text", name: "incidentType", placeholder: "traffic-accident" }),
      h("label", null, "Routes to L1 agent"),
      h("select", { name: "l1" }, l1Agents.map((a) => h("option", { key: a, value: a }, a))),
      h("label", null, "Action (what that L1 coordinates)"),
      h("input", { type: "text", name: "action", placeholder: "coordinate the accident response" }),
      h("button", { type: "submit" }, "Add trigger"),
    ),
    h("p", { className: "note" },
      "Stored in the ingest layer and read on every frame. The L1 you choose decides downstream via inference; dangerous steps are gated by OpenShell."),
  );
}

export const render = (element) => "<!doctype html>" + renderToStaticMarkup(element);
