#!/bin/zsh

set -u

probe_port="${HEMLOCK_MAPLE_PROBE_PORT:-18080}"
repo_root="/Users/ianzvirbulis/Code/Hemlock"
model_path="${HEMLOCK_MODEL_PATH:-/Users/ianzvirbulis/Models/Hemlock/maple-2bit-mlx}"
runtime_python="${HEMLOCK_PYTHON:-/Users/ianzvirbulis/Models/Hemlock/runtime/bin/python}"
runtime_site="/Users/ianzvirbulis/Models/Hemlock/runtime/lib/python3.13/site-packages"
system_site="/Library/Frameworks/Python.framework/Versions/3.13/lib/python3.13/site-packages"
log_path="$(mktemp -t hemlock-maple-health.XXXXXX)"
child_pid=""

cleanup() {
  if [[ -n "$child_pid" ]] && kill -0 "$child_pid" 2>/dev/null; then
    kill "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
  fi
  rm -f "$log_path"
}

trap cleanup EXIT INT TERM

if ! [[ -x "$runtime_python" ]]; then
  print -u2 "Maple runtime Python not found: $runtime_python"
  exit 3
fi

if ! [[ -d "$model_path" ]]; then
  print -u2 "Maple model not found: $model_path"
  exit 3
fi

if lsof -nP -iTCP:"$probe_port" -sTCP:LISTEN >/dev/null 2>&1; then
  print -u2 "Probe port is already in use: $probe_port"
  exit 3
fi

start_ns="$(python3 -c 'import time; print(time.time_ns())')"

PYTHONUNBUFFERED=1 \
PYTHONPATH="$repo_root:$runtime_site:$system_site" \
  "$runtime_python" -S -m mlx_lm server \
  --model "$model_path" \
  --host 127.0.0.1 \
  --port "$probe_port" \
  --trust-remote-code \
  --flash-head \
  --temp 0.7 \
  --top-p 0.95 \
  --top-k 20 \
  --max-tokens 512 \
  --log-level WARNING >"$log_path" 2>&1 &
child_pid=$!

for _ in {1..180}; do
  if ! kill -0 "$child_pid" 2>/dev/null; then
    print -u2 "Maple server exited before /health became ready"
    tail -40 "$log_path" >&2
    exit 1
  fi

  if curl -fsS --max-time 1 "http://127.0.0.1:$probe_port/health" >/dev/null 2>&1; then
    end_ns="$(python3 -c 'import time; print(time.time_ns())')"
    elapsed_ms="$(( (end_ns - start_ns) / 1000000 ))"
    print "health_ready_ms=$elapsed_ms"
    exit 0
  fi

  sleep 1
done

print -u2 "Maple server did not become ready within 180 seconds"
tail -40 "$log_path" >&2
exit 2
