#!/usr/bin/env bash
# Runs ON the Acer box. Proves the code is correct AND the running service works,
# on the device, not on a laptop. Exits non-zero the moment anything fails, so a
# caller can gate "green" on this.
#
#   scripts/box-verify.sh tests    # unit suite + compliance (code correctness)
#   scripts/box-verify.sh smoke    # black-box checks against the live service
#   scripts/box-verify.sh all      # both (default)
#
# "Functionality passed on the device" means the smoke section: it talks to the
# actually-running systemd service over HTTP, it does not re-simulate anything.
set -uo pipefail

MODE="${1:-all}"
HOST="${OMODA_HOST:-127.0.0.1}"
PORT="${OMODA_PORT:-3110}"
STREAM_PORT="${OMODA_STREAM_PORT:-3111}"
fails=0

say()  { printf '  %s\n' "$*"; }
pass() { printf '  \033[32mPASS\033[0m %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; fails=$((fails+1)); }

cd "$(dirname "$0")/.." || { echo "cannot cd to repo root"; exit 2; }

run_tests() {
  echo "== tests (code correctness, on the box) =="
  if node --test test/*.test.js > /tmp/omoda-box-tests.log 2>&1; then
    pass "unit suite ($(grep -E '^# pass' /tmp/omoda-box-tests.log | awk '{print $3}' | head -1 || echo ok) passing)"
  else
    fail "unit suite; tail:"; tail -6 /tmp/omoda-box-tests.log | sed 's/^/      /'
  fi
  if node scripts/compliance-check.mjs > /tmp/omoda-box-compliance.log 2>&1; then
    pass "compliance gate"
  else
    fail "compliance gate"; tail -4 /tmp/omoda-box-compliance.log | sed 's/^/      /'
  fi
}

code() { curl -s -m 6 -o /dev/null -w "%{http_code}" "$@" 2>/dev/null; }

run_smoke() {
  echo "== smoke (functionality, against the live service on the box) =="

  # 1. the service is actually up under systemd
  if systemctl is-active --quiet omoda.service 2>/dev/null; then
    pass "omoda.service active"
  else
    fail "omoda.service not active"
  fi

  # 2. health, UI, stream upgrade
  c=$(code "http://$HOST:$PORT/healthz");        [ "$c" = 200 ] && pass "GET /healthz 200" || fail "GET /healthz $c"
  # The portal can write (agent deploys), so it must be LOCKED anonymously and
  # open with the admin credential (default, or OMODA_ADMIN_* from .env).
  c=$(code "http://$HOST:$PORT/ui");             [ "$c" = 401 ] && pass "GET /ui anonymous -> 401 (locked)" || fail "GET /ui anonymous -> $c (want 401)"
  AUSER="${OMODA_ADMIN_USER:-$(grep -s '^OMODA_ADMIN_USER=' .env | cut -d= -f2-)}"; AUSER="${AUSER:-omoda-admin}"
  APASS="${OMODA_ADMIN_PASS:-$(grep -s '^OMODA_ADMIN_PASS=' .env | cut -d= -f2-)}"; APASS="${APASS:-SparkDo-OMODA-2026}"
  c=$(code -u "$AUSER:$APASS" "http://$HOST:$PORT/ui"); [ "$c" = 200 ] && pass "GET /ui with admin credential -> 200" || fail "GET /ui authenticated -> $c"
  c=$(code -u "$AUSER:$APASS" "http://$HOST:$PORT/ui/agents/new"); [ "$c" = 200 ] && pass "GET /ui/agents/new 200 (deploy flow up)" || fail "GET /ui/agents/new -> $c"
  SHOST="${OMODA_STREAM_HOST:-$(grep -s '^OMODA_STREAM_HOST=' .env | cut -d= -f2-)}"; SHOST="${SHOST:-$HOST}"
  c=$(code "http://$SHOST:$STREAM_PORT/");       [ "$c" = 426 ] && pass "stream 426 on $SHOST (upgrade required)" || fail "stream on $SHOST -> $c (want 426)"

  # 3. auth is enforced: a privileged read with no token must be refused, not served
  c=$(code "http://$HOST:$PORT/v1/ledger");      [ "$c" = 401 ] || [ "$c" = 403 ] && pass "GET /v1/ledger without token -> $c (refused)" || fail "GET /v1/ledger unauthenticated -> $c (want 401/403)"

  # 4. real Layer 3: the boot log shows the OpenShell policy, not the simulator
  if grep -q 'policy .*openshell sandbox' var/log/omoda.out 2>/dev/null; then
    pass "policy is OpenShell sandbox (Layer 3), not the in-process simulator"
  else
    fail "boot log does not show the OpenShell sandbox policy"
  fi

  # 5. Nemotron answers on the box. The model is the point; if it is down, the
  #    planner degrades and half the system's claims stop being demonstrable.
  c=$(code "http://127.0.0.1:8000/health")
  [ "$c" = 200 ] && pass "local Nemotron healthy on :8000" || fail "local Nemotron :8000 -> $c"

  #    The second NVIDIA model: NeMo Retriever embeddings for the proxy layer.
  c=$(code "http://127.0.0.1:3140/health")
  [ "$c" = 200 ] && pass "Nemotron Embed healthy on :3140" || fail "Nemotron Embed :3140 -> $c"

  #    The mock external service layer (city services the agents call).
  c=$(code "http://127.0.0.1:3120/health")
  [ "$c" = 200 ] && pass "city-services mock healthy on :3120" || fail "city-services :3120 -> $c"

  # 6. all three layers, end to end, against the live gateway. This is the one
  #    that proves the architecture rather than the process being up.
  if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ] && ! grep -q '^OPENCLAW_GATEWAY_TOKEN=' .env 2>/dev/null; then
    fail "three-layer demo cannot run: OPENCLAW_GATEWAY_TOKEN absent from .env on the box"
  elif node src/demo/three-layer.js > /tmp/omoda-three-layer.log 2>&1; then
    # Assert the SUBSTANCE, not just the exit code.
    if grep -q 'hello-ok' /tmp/omoda-three-layer.log \
       && grep -q 'no human in the loop' /tmp/omoda-three-layer.log \
       && grep -q 'after revert: 403' /tmp/omoda-three-layer.log \
       && grep -q 'gateway-self-protection' /tmp/omoda-three-layer.log \
       && grep -q '"ok":true' /tmp/omoda-three-layer.log; then
      pass "three layers end to end: gateway paired, read unattended, write reverted, prohibited refused"
    else
      fail "three-layer demo ran but did not prove all four properties; see /tmp/omoda-three-layer.log"
    fi
  else
    fail "three-layer demo failed; tail:"; tail -5 /tmp/omoda-three-layer.log | sed 's/^/      /'
  fi
}

case "$MODE" in
  tests) run_tests ;;
  smoke) run_smoke ;;
  all)   run_tests; run_smoke ;;
  *)     echo "usage: box-verify.sh [tests|smoke|all]"; exit 2 ;;
esac

echo
if [ "$fails" -eq 0 ]; then
  echo "  GREEN on the device ($MODE)"
  exit 0
else
  echo "  RED on the device: $fails check(s) failed ($MODE)"
  exit 1
fi
