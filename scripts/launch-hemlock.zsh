#!/bin/zsh

set -u
setopt NULL_GLOB

repo_root=""
finder_launch=0
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
log_dir="${HOME}/Library/Logs/Hemlock"
log_file="$log_dir/launch.log"
lock_root="${HOME}/Library/Application Support/Hemlock"
lock_dir="$lock_root/launch.lock"

mkdir -p "$log_dir" "$lock_root"
exec >>"$log_file" 2>&1
print "[$(date '+%Y-%m-%dT%H:%M:%S%z')] launch requested repo=$repo_root finder=$finder_launch pid=$$"

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
npm_candidates+=(
  "${HEMLOCK_NPM:-}"
  "/opt/homebrew/bin/npm"
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

cd "$app_dir"
if [[ "${HEMLOCK_LAUNCH_DRY_RUN:-0}" == "1" ]]; then
  print "[$(date '+%Y-%m-%dT%H:%M:%S%z')] dry run: would execute $npm_bin run desktop with MAPLE_AUTOSTART_SERVER=1"
  exit 0
fi
print "[$(date '+%Y-%m-%dT%H:%M:%S%z')] starting Hemlock desktop and Maple via $npm_bin"
"$npm_bin" run desktop
exit_code=$?
print "[$(date '+%Y-%m-%dT%H:%M:%S%z')] Hemlock desktop exited code=$exit_code"

if (( exit_code != 0 && finder_launch )) && command -v osascript >/dev/null 2>&1; then
  osascript -e "display dialog \"Hemlock stopped before opening. See ${log_file:t} in ~/Library/Logs/Hemlock for details.\" with title \"Hemlock could not start\" buttons {\"OK\"} default button \"OK\"" >/dev/null 2>&1 || true
fi
exit "$exit_code"
