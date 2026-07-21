#!/usr/bin/env bash
# loud-build.sh — run a long command so it can NEVER go silent or unbounded.
#
# Why: a backgrounded gradle build that runs 50 min with no output is
# indistinguishable from a hang. This wrapper emits a heartbeat on a fixed
# interval (proof of life + liveness signal) and hard-kills past a time cap,
# always failing loud with a non-zero exit. Fail-loud, never silent.
#
# Usage:
#   loud-build.sh [-m MAX_SECS] [-i HEARTBEAT_SECS] [-l LOGFILE] -- <command...>
# Env overrides: LB_MAX_SECS, LB_HEARTBEAT_SECS, LB_LOG
#
# Exit codes:  <cmd exit> propagated | 124 hard timeout (killed) | 2 usage
set -uo pipefail

MAX_SECS="${LB_MAX_SECS:-1800}"        # 30 min default hard cap
HEARTBEAT_SECS="${LB_HEARTBEAT_SECS:-60}"
LOG="${LB_LOG:-}"

while getopts "m:i:l:" opt; do
  case "$opt" in
    m) MAX_SECS="$OPTARG" ;;
    i) HEARTBEAT_SECS="$OPTARG" ;;
    l) LOG="$OPTARG" ;;
    *) echo "usage: loud-build.sh [-m max] [-i beat] [-l log] -- <cmd...>" >&2; exit 2 ;;
  esac
done
shift $((OPTIND-1))
[ "${1:-}" = "--" ] && shift
[ "$#" -eq 0 ] && { echo "loud-build: no command" >&2; exit 2; }
[ -z "$LOG" ] && LOG="/tmp/loud-build-$$.log"
: > "$LOG"

killtree() { local p=$1 c; for c in $(pgrep -P "$p" 2>/dev/null); do killtree "$c"; done; kill -9 "$p" 2>/dev/null; }

echo "── loud-build ── $*"
echo "── log:$LOG  heartbeat:${HEARTBEAT_SECS}s  hard-cap:${MAX_SECS}s"

"$@" >"$LOG" 2>&1 &
CMD_PID=$!
START=$(date +%s)

(
  while kill -0 "$CMD_PID" 2>/dev/null; do
    sleep "$HEARTBEAT_SECS"
    kill -0 "$CMD_PID" 2>/dev/null || break
    EL=$(( $(date +%s) - START ))
    BUSY=$(ps -Ao pcpu,comm 2>/dev/null | grep -Ei 'java|node|webpack|kotlin|clang|cc1|d8' | sort -nr | head -1 | awk '{printf "%s%% %s",$1,$2}')
    LAST=$(grep -av '^[[:space:]]*$' "$LOG" 2>/dev/null | tail -1 | cut -c1-90)
    printf '   heartbeat +%dm%02ds | busiest: %s | last: %s\n' $((EL/60)) $((EL%60)) "${BUSY:-idle}" "${LAST:-<no output yet>}"
    if [ "$EL" -ge "$MAX_SECS" ]; then
      echo ""; echo "xxx loud-build HARD TIMEOUT ${EL}s (cap ${MAX_SECS}s) — killing process tree"
      echo "    last log line: ${LAST:-<none>}"
      killtree "$CMD_PID"; exit 124
    fi
  done
) &
HB_PID=$!

wait "$CMD_PID"; CODE=$?
kill "$HB_PID" 2>/dev/null; wait "$HB_PID" 2>/dev/null
DUR=$(( $(date +%s) - START ))

# If heartbeat killed the cmd for timeout, CMD_PID is dead; surface that loudly.
if [ "$CODE" -eq 0 ]; then
  echo "OK loud-build done in ${DUR}s — $LOG"
else
  echo "FAIL loud-build exit=$CODE in ${DUR}s — tail of $LOG:"
  tail -8 "$LOG" 2>/dev/null | sed 's/^/    /'
fi
exit "$CODE"
