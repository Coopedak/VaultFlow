#!/usr/bin/env bash
#
# Install the Dev Team plugin from THIS folder (local marketplace), no GitHub needed.
#
# For the hand-off / exported copy. Registers this extracted folder as a Claude Code marketplace and
# installs the plugin. Requires the `claude` CLI; Node.js is needed for analytics.
#
# Usage: ./scripts/install-local.sh [--scope user|project]   (default: user)
#
# Equivalent inside Claude Code (use the full path to this folder):
#   /plugin marketplace add "<this folder>"
#   /plugin install dev-team@dev-team
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"   # the plugin = marketplace root, one level up from scripts/
SCOPE="user"

while [ $# -gt 0 ]; do
  case "$1" in
    --scope) SCOPE="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

echo "Dev Team installer (local)"
echo "Plugin folder: $ROOT"

if ! command -v claude >/dev/null 2>&1; then
  echo "ERROR: the 'claude' CLI was not found on PATH. Install Claude Code first, then re-run." >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "WARNING: Node.js not found on PATH. The plugin installs fine, but analytics (logging + /dev-team-report) need Node." >&2
fi
if [ ! -f "$ROOT/.claude-plugin/marketplace.json" ]; then
  echo "ERROR: marketplace.json not found in $ROOT/.claude-plugin/. Run this from inside the extracted dev-team folder." >&2
  exit 1
fi

echo
echo "Registering local marketplace..."
claude plugin marketplace add "$ROOT"

echo
echo "Installing dev-team@dev-team (scope: $SCOPE) ..."
claude plugin install "dev-team@dev-team" --scope "$SCOPE"

echo
echo "Done."
echo "Try it: open Claude Code and say 'use the dev team on <your task>'."
echo "Analytics: run /dev-team-report to see team activity."
