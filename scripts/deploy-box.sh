#!/usr/bin/env bash
# The ONLY way we deploy OMODA. Run from a workstation; it deploys to the actual
# Acer box and refuses to report green unless the tests and the functional smoke
# BOTH pass on the device.
#
#   scripts/deploy-box.sh                # deploy origin/main
#   scripts/deploy-box.sh <git-ref>      # deploy a specific ref
#
# Policy: "green" means green on the box. A laptop test run is necessary but never
# sufficient. This script makes the box the source of truth. See docs/deployment.md.
set -uo pipefail

REF="${1:-origin/main}"
BOX="${OMODA_BOX:-arif@100.71.143.26}"
DIR="${OMODA_BOX_DIR:-/home/arif/omoda}"
SVC="omoda.service"

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die()  { printf '\n\033[31mDEPLOY ABORTED: %s\033[0m\n' "$*" >&2; exit 1; }

sshb() { ssh -o ConnectTimeout=25 "$BOX" "$@"; }

step "Preflight: box reachable, ref exists"
sshb "cd $DIR && git rev-parse --is-inside-work-tree >/dev/null" || die "box checkout $DIR not found or unreachable"
git rev-parse --verify "$REF" >/dev/null 2>&1 || git fetch -q origin
git rev-parse --verify "$REF" >/dev/null 2>&1 || die "ref '$REF' does not exist"
echo "  box: $BOX:$DIR   deploying ref: $REF"

step "Sync box to $REF and install dependencies"
# The venue network drops github.com resolution intermittently. A failed fetch
# leaves the box on an older commit and the parity check below catches it, but
# a retry here turns a hard abort into a pause. Three attempts, then give up
# loudly rather than deploying something stale.
fetched=0
for attempt in 1 2 3; do
  if sshb "cd $DIR && git fetch -q origin 2>/dev/null"; then fetched=1; break; fi
  echo "  fetch attempt $attempt failed (DNS or network); retrying in 5s"
  sleep 5
done
[ "$fetched" = 1 ] || die "could not fetch on the box after 3 attempts; check DNS: ssh $BOX 'getent hosts github.com'"
sshb "cd $DIR && git checkout -q \$(git rev-parse --abbrev-ref $REF 2>/dev/null || echo main) 2>/dev/null; git reset -q --hard $REF && echo '  box now at' \$(git rev-parse --short HEAD)" || die "git sync failed on the box"
sshb "cd $DIR && npm ci >/tmp/omoda-npm.log 2>&1 && echo '  deps installed' || { tail -5 /tmp/omoda-npm.log; exit 1; }" || die "npm ci failed on the box"

step "Parity check: box tree must equal $REF exactly"
BOX_TREE=$(sshb "cd $DIR && git rev-parse HEAD^{tree}")
REF_TREE=$(git rev-parse "$REF^{tree}")
[ "$BOX_TREE" = "$REF_TREE" ] || die "box tree $BOX_TREE != ref tree $REF_TREE"
echo "  tree match: $BOX_TREE"

step "Tests on the device (code correctness)"
sshb "cd $DIR && bash scripts/box-verify.sh tests" || die "tests failed on the box; NOT deploying a broken build"

step "Restart the service and wait for health"
sshb "sudo systemctl restart $SVC" || die "systemctl restart failed"
ok=0
for i in $(seq 1 20); do
  c=$(sshb "curl -s -m 4 -o /dev/null -w '%{http_code}' http://127.0.0.1:3110/healthz" 2>/dev/null)
  [ "$c" = 200 ] && { ok=1; echo "  healthy after $((i*2))s"; break; }
  sleep 2
done
[ "$ok" = 1 ] || die "service did not become healthy after restart; check: ssh $BOX 'journalctl -u $SVC -n50'"

step "Functional smoke on the device"
sshb "cd $DIR && bash scripts/box-verify.sh smoke" || die "functional smoke failed on the box; the deploy is RED"

step "Deployed"
echo "  $REF is live on $BOX and GREEN on the device."
echo "  commit: $(git rev-parse --short $REF)   service: $(sshb "systemctl is-active $SVC")"
