#!/usr/bin/env bash
# Concern: one-command deploy of the webapp to the DGX (sync -> restart backend -> relaunch frontend -> verify) | Non-concern: app logic, model setup | IO: (local repo) -> running backend + frontend on the DGX, URLs printed
#
# The DGX copy at $REMOTE_REPO is a plain rsync target (NOT a git checkout) and is
# bind-mounted into the backend container as /work. The frontend is a vite dev
# server run inside a persistent tmux session so it survives ssh disconnects.
#
# Fails loud: any step that does not converge exits non-zero and dumps the backend
# log tail so the reason is on screen, never swallowed.
set -euo pipefail

REMOTE="${DGX_HOST:-gn100}"
REMOTE_REPO="/home/acer01/hackathon"
BACKEND_CONTAINER="pipeline-backend"
BACKEND_PORT="8091"
FRONTEND_PORT="${FRONTEND_PORT:-5180}"   # freed from `tailscale serve`; strictPort fails loud if re-squatted
TMUX_SESSION="viteapp"
SSH_OPTS="-o ConnectTimeout=8"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_REPO="$SCRIPT_DIR"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  ok\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31mFAILED: %s\033[0m\n' "$*" >&2; exit 1; }

# --- 1. sync repo laptop -> DGX -----------------------------------------------
# --delete keeps the DGX identical to local WITHIN webapp/, but node_modules and
# the runtime-only live/ upload dir are excluded so they are never touched.
say "sync $LOCAL_REPO/webapp -> $REMOTE:$REMOTE_REPO/webapp"
rsync -az --delete \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude '__pycache__' \
  --exclude '*.pyc' \
  --exclude 'webapp/backend/live' \
  --exclude 'webapp/backend/jobs' \
  --exclude 'webapp/backend/*.pt' \
  --exclude 'webapp/backend/*mobileclip*' \
  --exclude 'webapp/backend/_*.py' \
  -e "ssh $SSH_OPTS" \
  "$LOCAL_REPO/webapp" "$REMOTE:$REMOTE_REPO/" \
  || die "rsync failed"
ok "synced"

# --- 2. restart backend (reloads app.py; preserves --network host + HF env) ---
say "restart backend container '$BACKEND_CONTAINER'"
ssh $SSH_OPTS "$REMOTE" "docker restart $BACKEND_CONTAINER" >/dev/null \
  || die "docker restart failed"
ok "restart issued"

# --- 3. wait for backend health (bounded; dumps logs on failure) --------------
say "wait for backend health on :$BACKEND_PORT (models load can take ~60s)"
healthy=""
for _ in $(seq 1 45); do
  code="$(ssh $SSH_OPTS "$REMOTE" "curl -s --max-time 3 -o /dev/null -w '%{http_code}' http://localhost:$BACKEND_PORT/api/health" 2>/dev/null || true)"
  if [ "$code" = "200" ]; then healthy="1"; break; fi
  sleep 2
done
if [ -z "$healthy" ]; then
  ssh $SSH_OPTS "$REMOTE" "docker logs --tail 40 $BACKEND_CONTAINER" >&2 || true
  die "backend never returned 200 on /api/health"
fi
ssh $SSH_OPTS "$REMOTE" "curl -s http://localhost:$BACKEND_PORT/api/health"; echo
ok "backend healthy"

# --- 4. (re)launch frontend in a persistent tmux session ----------------------
# strictPort so vite fails loudly instead of silently drifting to another port.
say "relaunch vite in tmux '$TMUX_SESSION' on :$FRONTEND_PORT"
ssh $SSH_OPTS "$REMOTE" "
  tmux kill-session -t $TMUX_SESSION 2>/dev/null
  cd $REMOTE_REPO/webapp/frontend
  tmux new-session -d -s $TMUX_SESSION 'npm run dev -- --host 0.0.0.0 --port $FRONTEND_PORT --strictPort'
" || die "tmux launch failed"
ok "tmux session started"

# --- 5. wait for frontend to serve (bounded) ----------------------------------
say "wait for frontend on :$FRONTEND_PORT"
serving=""
for _ in $(seq 1 30); do
  code="$(ssh $SSH_OPTS "$REMOTE" "curl -s --max-time 3 -o /dev/null -w '%{http_code}' http://localhost:$FRONTEND_PORT/" 2>/dev/null || true)"
  if [ "$code" = "200" ]; then serving="1"; break; fi
  sleep 2
done
if [ -z "$serving" ]; then
  ssh $SSH_OPTS "$REMOTE" "tmux capture-pane -pt $TMUX_SESSION 2>/dev/null | tail -30" >&2 || true
  die "frontend never served 200 on :$FRONTEND_PORT"
fi
ok "frontend serving"

# --- 6. print URLs ------------------------------------------------------------
REMOTE_IP="$(ssh $SSH_OPTS "$REMOTE" "tailscale ip -4 2>/dev/null | head -1" || true)"
[ -n "$REMOTE_IP" ] || REMOTE_IP="$REMOTE"
say "deployed"
echo "  frontend : http://$REMOTE_IP:$FRONTEND_PORT/"
echo "  backend  : http://$REMOTE_IP:$BACKEND_PORT/api/health"
