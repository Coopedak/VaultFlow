#!/usr/bin/env bash
#
# Install the Dev Team plugin on this machine from GitHub.
#
# Registers the ProgressiveSurface/dev-team repo as a Claude Code marketplace and installs the plugin.
# The repo is its own marketplace, so this is just the two `claude plugin` commands plus a preflight.
# Works on any device — no local clone required. Requires the `claude` CLI; Node.js is needed for analytics.
#
# Usage: ./scripts/install.sh [--scope user|project]   (default: user)
#
# Equivalent inside Claude Code:
#   /plugin marketplace add ProgressiveSurface/dev-team
#   /plugin install dev-team@dev-team
set -euo pipefail

REPO="ProgressiveSurface/dev-team"   # GitHub org/repo (also the marketplace name: "dev-team")
PLUGIN="dev-team@dev-team"            # plugin@marketplace
SCOPE="user"

while [ $# -gt 0 ]; do
  case "$1" in
    --scope) SCOPE="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

echo "Dev Team installer"

if ! command -v claude >/dev/null 2>&1; then
  echo "ERROR: the 'claude' CLI was not found on PATH. Install Claude Code first, then re-run." >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "WARNING: Node.js not found on PATH. The plugin installs fine, but analytics (logging + /dev-team-report) need Node." >&2
fi

echo
echo "Registering marketplace $REPO ..."
claude plugin marketplace add "$REPO"

echo
echo "Installing $PLUGIN (scope: $SCOPE) ..."
claude plugin install "$PLUGIN" --scope "$SCOPE"

echo
echo "Done."
echo "Try it: open Claude Code and say 'use the dev team on <your task>'."
echo "Analytics: run /dev-team-report to see team activity."
echo "Update later: claude plugin marketplace update dev-team"
