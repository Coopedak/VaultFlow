# Dev Team Analytics

Lightweight, automatic instrumentation of team activity. Zero effort from the PM — it runs via hooks.

## How it works

The plugin registers three hooks ([`../hooks/hooks.json`](../hooks/hooks.json)):

- **SessionStart** → logs a `session_start` event.
- **PostToolUse** (matcher `Task`) → every time a subagent is dispatched, logs a `dispatch` event with
  the role (`subagent_type`), a short label, the session, and the project path.
- **Stop** → logs a `session_end` event.

Each hook runs [`log-event.mjs`](log-event.mjs), which appends one JSON line to:

```
${CLAUDE_PLUGIN_DATA}/events.jsonl
```

`${CLAUDE_PLUGIN_DATA}` is the plugin's persistent data dir — it survives plugin updates and is
per-machine, so analytics accumulate across sessions. If that path isn't provided, the logger falls
back to `~/.claude/dev-team-analytics/`.

The logger is **fail-safe by design**: it catches every error and always exits 0, so a logging hiccup
can never block a tool call or stop the agent.

## Viewing the report

Run the slash command:

```
/dev-team-report
```

or invoke the reporter directly:

```
node analytics/report.mjs --data "<plugin-data-dir>" [--since YYYY-MM-DD] [--limit N] [--json]
```

It reports:
- **Dispatches by role** — how often each agent (PM, voice-of-reason, researcher, developer, reviewer, documenter) was used.
- **Review-loop depth** — review rounds per run and the average; runs that hit the 3-round cap are flagged ⚠️.
- **Cycle time** — wall-clock duration of each run (first to last dispatch).
- **Recent runs** — the most recent sessions where the team actually ran.

Pass `--json` for machine-readable output (e.g. to feed a dashboard).

## Requirements

Node.js (the project audience already uses Node). No external packages — standard library only.

## Privacy

Nothing leaves your machine. Events are stored locally in the plugin data directory. Delete
`events.jsonl` to reset analytics.
