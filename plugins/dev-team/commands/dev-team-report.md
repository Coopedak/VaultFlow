---
description: Show Dev Team analytics — subagent dispatches per role, review-loop depth, and cycle time per run.
argument-hint: "[--since YYYY-MM-DD] [--limit N]"
---

Generate and present the Dev Team analytics report.

Run this command (pass through any arguments the user provided in `$ARGUMENTS`):

```
node "${CLAUDE_PLUGIN_ROOT}/analytics/report.mjs" --data "${CLAUDE_PLUGIN_DATA}" $ARGUMENTS
```

The script prints a Markdown report read from the analytics event log. Present its output to the user
as-is (it's already formatted). If it reports no activity yet, tell the user the team hasn't run since
analytics were enabled and that activity is logged automatically once they use the dev team.

If `node` isn't available on this machine, say so — the analytics logger and reporter both require Node.
