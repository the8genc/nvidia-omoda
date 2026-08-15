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

export function SkillsPage({ skills }) {
  return h(Layout, { title: "skills", active: "skills" },
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

export const render = (element) => "<!doctype html>" + renderToStaticMarkup(element);
