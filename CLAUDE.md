# OMODA: working notes for any session

## Writing issues

Every GitHub issue must carry an **Impact** section: what breaks if it is not
done, why it lands on the named owner, and what is blocked downstream. This holds
whether the issue is filed through the template or `gh issue create --body`. The
full standard is `docs/issue-standard.md`; #13 and #26 are the reference bar.
Blockers get a `[<TEAM> BLOCKER]` title prefix and `blocked` + `needs:<team>` +
`block:Pn` labels. Name the owning team when filing; do not default to one.

## Deploying: green means green on the box

**A laptop test run is never "done".** Nothing counts as deployed or green until
it passes on the actual Acer box (`arif@100.71.143.26`), both the test suite and a
functional smoke against the running service. Local `node --test` is necessary but
not sufficient.

Deploy only through `scripts/deploy-box.sh` (default ref `origin/main`). It syncs
the box, installs deps, checks the tree hash matches the ref exactly, runs the
suite **on the box**, restarts the `omoda` systemd service, and runs a functional
smoke **against the live service** (health, UI, stream upgrade, auth-enforced,
OpenShell policy active). It aborts and prints RED if any step fails on the device.
`scripts/box-verify.sh {tests|smoke|all}` is the on-device check it runs. Full
policy in `docs/deployment.md`.

The box runs the service as a systemd unit (`sudo systemctl {status,restart} omoda`);
it is the single Telegram poller, so do not run `serve:live`/`demo:live` locally at
the same time.

## Shared infrastructure (the GN100 box)

Read `docs/shared-infra.md` before touching the box. The rules that bite:
- Bind only inside **3100-3199**. `src/domain/prohibited.js` enforces it.
- Access as `arif` (`ssh gn100`); `/home/acer01` is the shared account, off-limits.
- The shared vLLM lives in `/opt/spark`; do not lower its context below 64000.
- Never kill `tailscaled` (pid 2344); it is the tailnet.

## Secrets

Live secrets go only in `.env` (gitignored, mode 600), never in a tracked file,
never echoed into the transcript. The automated safety layer will refuse to read
credential material through the agent; that is correct, work with it, do not route
around it. Rotation is tracked in the pre-demo issues.

## Conventions

- Node ESM, no build step, plain JS + `zod`, `node:test`. SSR React via
  `renderToStaticMarkup`, no JSX, no client bundle.
- Two-week open-source rule: a pinned dependency's version must have been published
  on or before **2026-08-01**. `scripts/compliance-check.mjs` gates it.
- Writing style follows the global rules in `~/.claude/CLAUDE.md` (no em dashes, no
  "X, not Y" reflex, no self-assessment sections in deliverables).
