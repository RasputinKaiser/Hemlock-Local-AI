#!/bin/zsh

# ── Native-arch guard ──────────────────────────────────────────────────────
# If this script is launched under Rosetta translation (an x86_64 process on
# Apple Silicon), the Node.js it spawns reports process.arch === "x64" and the
# native bundler bindings (rolldown/oxc .node files) fail to load because only
# their arm64 variant is installed. That crash takes Vite down, and
# `concurrently -k` then kills Electron — so the app never opens and Maple is
# never reachable. Re-exec natively so everything downstream runs arm64.
if [[ "$(uname -m)" == "arm64" ]]; then
  translated="$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)"
  if [[ "$translated" == "1" ]]; then
    exec /usr/bin/arch -arm64 "$0" "$@"
  fi
fi

set -u
setopt NULL_GLOB

repo_root=""
finder_launch=0
dev_mode=0
while (( $# > 0 )); do
  case "$1" in
    --repo-root)
      repo_root="${2:-}"
      shift 2
      ;;
    --app)
      finder_launch=1
      shift
      ;;
    --dev)
      # Old development flow: Vite dev server + HMR via concurrently.
      dev_mode=1
      shift
      ;;
    *)
      print -u2 "Unknown Hemlock launcher option: $1"
      exit 64
      ;;
  esac
done

if [[ -z "$repo_root" ]]; then
  print -u2 "Hemlock launcher needs --repo-root."
  exit 64
fi

repo_root="$(cd -- "$repo_root" && pwd)"
app_dir="$repo_root/dream-chat"
dist_index="$app_dir/dist/index.html"
electron_bin="$app_dir/node_modules/.bin/electron"
log_dir="${HOME}/Library/Logs/Hemlock"
log_file="$log_dir/launch.log"
lock_root="${HOME}/Library/Application Support/Hemlock"
lock_dir="$lock_root/launch.lock"

mkdir -p "$log_dir" "$lock_root"
exec >>"$log_file" 2>&1
print "[$(date '+%Y-%m-%dT%H:%M:%S%z')] launch requested repo=$repo_root finder=$finder_launch dev=$dev_mode pid=$$"

if [[ ! -d "$app_dir" || ! -f "$app_dir/package.json" ]]; then
  print -u2 "Hemlock app directory was not found: $app_dir"
  exit 1
fi

if [[ ! -d "$app_dir/node_modules" ]]; then
  print -u2 "Hemlock dependencies are missing at $app_dir/node_modules"
  print -u2 "Run npm install once from $app_dir, then double-click Hemlock.app again."
  exit 1
fi

if ! mkdir "$lock_dir" 2>/dev/null; then
  existing_pid=""
  if [[ -f "$lock_dir/pid" ]]; then
    existing_pid="$(<"$lock_dir/pid")"
  fi
  if [[ "$existing_pid" == <-> ]] && kill -0 "$existing_pid" 2>/dev/null; then
    print "[$(date '+%Y-%m-%dT%H:%M:%S%z')] Hemlock is already launching/running pid=$existing_pid; ignoring duplicate launch."
    exit 0
  fi
  print "[$(date '+%Y-%m-%dT%H:%M:%S%z')] Removing stale launcher lock pid=$existing_pid."
  rm -f "$lock_dir/pid"
  rmdir "$lock_dir" 2>/dev/null || true
  mkdir "$lock_dir" 2>/dev/null || {
    print -u2 "Hemlock could not acquire its launch lock: $lock_dir"
    exit 1
  }
fi
print "$$" > "$lock_dir/pid"
cleanup() {
  rm -f "$lock_dir/pid"
  rmdir "$lock_dir" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

typeset -a npm_candidates
npm_candidates=()
if command -v npm >/dev/null 2>&1; then
  npm_candidates+=("$(command -v npm)")
fi
# On Apple Silicon prefer the native arm64 Homebrew install over /usr/local
# (which can be a universal binary that runs translated under Rosetta).
if [[ "$(uname -m)" == "arm64" ]]; then
  npm_candidates+=("/opt/homebrew/bin/npm")
fi
npm_candidates+=(
  "${HEMLOCK_NPM:-}"
  "/usr/local/bin/npm"
  "${HOME}/.volta/bin/npm"
  "${HOME}/.nvm/current/bin/npm"
  ${HOME}/.nvm/versions/node/*/bin/npm
)

npm_bin=""
for candidate in "${npm_candidates[@]}"; do
  if [[ -x "$candidate" ]]; then
    npm_bin="$candidate"
    break
  fi
done

if [[ -z "$npm_bin" ]]; then
  print -u2 "npm was not found for Finder-launched Hemlock. Set HEMLOCK_NPM or install Node/npm in /opt/homebrew/bin."
  if (( finder_launch )) && command -v osascript >/dev/null 2>&1; then
    osascript -e 'display dialog "Hemlock could not find Node/npm. Install Node.js, then open Hemlock.app again." with title "Hemlock could not start" buttons {"OK"} default button "OK"' >/dev/null 2>&1 || true
  fi
  exit 1
fi

export PATH="$(dirname "$npm_bin"):$PATH"
export MAPLE_AUTOSTART_SERVER=1
export HEMLOCK_LAUNCH_MODE=double-click
export HEMLOCK_REPO_ROOT="$repo_root"

# ── Stale-server reap ──────────────────────────────────────────────────────
# A previous Hemlock run (or crash) can leave mlx_lm holding 127.0.0.1:8080.
# The Electron host would adopt it — but if it's wedged, chat breaks subtly
# and a second mlx_lm can spawn-fail with EADDRINUSE. Reap any mlx_lm
# listener before boot; never touch non-mlx_lm processes.
if command -v lsof >/dev/null 2>&1; then
  stale_pids=$(lsof -nP -iTCP:8080 -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $2}' | sort -u)
  for stale_pid in ${=stale_pids}; do
    if ps -p "$stale_pid" -o command= 2>/dev/null | grep -q "mlx_lm"; then
      print "[$(date '+%Y-%m-%dT%H:%M:%S%z')] reaping stale mlx_lm server pid=$stale_pid on port 8080"
      kill -9 "$stale_pid" 2>/dev/null || true
    fi
  done
  # Give the port a moment to free if we reaped anything.
  if [[ -n "$stale_pids" ]]; then
    for _ in {1..5}; do
      lsof -nP -iTCP:8080 -sTCP:LISTEN >/dev/null 2>&1 || break
      sleep 1
    done
  fi
fi

cd "$app_dir"
if [[ "${HEMLOCK_LAUNCH_DRY_RUN:-0}" == "1" ]]; then
  print "[$(date '+%Y-%m-%dT%H:%M:%S%z')] dry run: would execute $npm_bin run desktop with MAPLE_AUTOSTART_SERVER=1"
  exit 0
fi

exit_code=0
if (( ! dev_mode )); then
  # ── Production UI flow (default for double-click) ──────────────────────
  # Electron loads the pre-built dist/ bundle directly. No Vite dev server,
  # no concurrently, no npm wrapper chain: one Node process instead of two,
  # roughly 7 GB less resident memory, and a faster, quieter start.
  if [[ ! -x "$electron_bin" ]]; then
    print -u2 "Electron binary missing at $electron_bin. Run npm install from $app_dir."
    exit_code=1
  elif [[ ! -f "$dist_index" ]]; then
    print -u2 "Built UI missing at $dist_index. Run 'npm run build' from $app_dir once, or launch with --dev."
    if (( finder_launch )) && command -v osascript >/dev/null 2>&1; then
      osascript -e "display dialog \"Hemlock's UI bundle is missing. Run: cd $app_dir && npm run build — then open Hemlock again.\" with title \"Hemlock could not start\" buttons {\"OK\"} default button \"OK\"" >/dev/null 2>&1 || true
    fi
    exit_code=1
  else
    export HEMLOCK_PROD_UI=1
    print "[$(date '+%Y-%m-%dT%H:%M:%S%z')] starting Hemlock desktop (prod UI) via $electron_bin"
    "$electron_bin" electron/main.cjs
    exit_code=$?
  fi
else
  # ── Development flow (opt-in) ───────────────────────────────────────────
  # Vite dev server with HMR plus Electron pointed at it.
  print "[$(date '+%Y-%m-%dT%H:%M:%S%z')] starting Hemlock desktop and Maple via $npm_bin (dev mode)"
  "$npm_bin" run desktop
  exit_code=$?
fi

# ── Readiness wait (foreground launches only) ─────────────────────────────
# Block until the local Maple server answers /health so callers (and humans)
# see one clean "ready" line instead of guessing. Skipped when the Electron
# app exits immediately or when explicitly disabled.
if (( exit_code == 0 )) && [[ "$HEMLOCK_LAUNCH_DRY_RUN" != "1" ]] && [[ "$HEMLOCK_SKIP_READINESS_WAIT" != "1" ]]; then
  ready_after=""
  for i in {1..120}; do
    if command -v curl >/dev/null 2>&1 && curl -s -m 2 http://127.0.0.1:8080/health 2>/dev/null | grep -q '"status"'; then
      ready_after="$i"
      break
    fi
    # Stop waiting if the Electron process died while we polled.
    pgrep -f "electron/main.cjs" >/dev/null 2>&1 || break
    sleep 1
  done
  if [[ -n "$ready_after" ]]; then
    print "[$(date '+%Y-%m-%dT%H:%M:%S%z')] Hemlock server ready after ${ready_after}s"
  else
    print "[$(date '+%Y-%m-%dT%H:%M:%S%z')] warning: server readiness not confirmed within 120s (app may still be loading the model)"
  fi
fi

print "[$(date '+%Y-%m-%dT%H:%M:%S%z')] Hemlock desktop exited code=$exit_code"

if (( exit_code != 0 && finder_launch )) && command -v osascript >/dev/null 2>&1; then
  osascript -e "display dialog \"Hemlock stopped before opening. See ${log_file:t} in ~/Library/Logs/Hemlock for details.\" with title \"Hemlock could not start\" buttons {\"OK\"} default button \"OK\"" >/dev/null 2>&1 || true
fi
exit "$exit_code"
