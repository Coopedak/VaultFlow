#!/usr/bin/env bash
#
# Run the Dev Team headlessly against a project from another process (CI, script, scheduler).
#
# Wraps `claude -p` to trigger the dev-team skill non-interactively. The session adopts the
# Project Manager role and dispatches the worker subagents. Requires the dev-team plugin to be
# installed (run scripts/install.sh first) and the `claude` CLI on PATH.
#
# Usage:
#   run-team.sh [--project <dir>] [--json] [--yolo] "<task>"
#
#   --project <dir>  Target repo (default: current directory)
#   --json           Emit structured JSON (--output-format json) instead of text
#   --yolo           Fully unattended: --dangerously-skip-permissions (sandbox/CI only).
#                    Default is --permission-mode acceptEdits.
#
# Examples:
#   run-team.sh "add a search box to the customer list"
#   run-team.sh --project ~/git/MyApp --json --yolo "implement issue #42"
set -euo pipefail

PROJECT="$PWD"
JSON=0
YOLO=0
TASK=""

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --json)    JSON=1; shift ;;
    --yolo)    YOLO=1; shift ;;
    --)        shift; TASK="${TASK:+$TASK }$*"; break ;;
    *)         TASK="${TASK:+$TASK }$1"; shift ;;
  esac
done

if ! command -v claude >/dev/null 2>&1; then
  echo "ERROR: the 'claude' CLI was not found on PATH. Install Claude Code and the dev-team plugin first." >&2
  exit 1
fi
if [ -z "$TASK" ]; then
  echo "ERROR: provide a task, e.g.  run-team.sh 'add a search box to the customer list'" >&2
  exit 1
fi

PROMPT="Use the dev team to: $TASK"

PERM=(--permission-mode acceptEdits)
[ "$YOLO" -eq 1 ] && PERM=(--dangerously-skip-permissions)

FMT=()
[ "$JSON" -eq 1 ] && FMT=(--output-format json)

echo "Dev Team (headless) → $PROJECT"
echo "Task: $TASK"
echo

( cd "$PROJECT" && claude -p "$PROMPT" "${PERM[@]}" "${FMT[@]}" )
