# vaultflow TUI — ASCII/ANSI Design Mockup

> **Target terminal width:** 130 columns  
> **Left panel:** 36 columns (fixed, never scrolls)  
> **Divider:** 1 column (`│`)  
> **Right panel:** 93 columns (scrollable terminal output)  
> **Color labels:** `[ORANGE]` `[PURPLE]` `[CYAN]` `[GREEN]` `[YELLOW]` `[GREY]` `[WHITE]` `[INVERT]` `[DIM]`  
> **Box chars used:** `┌ ─ ┐ │ └ ┘ ├ ┤ ┬ ┴ ┼ ▼ ▶ ● ○ █ ░ ▓`

---

## 1. Color & Symbol Reference

| Symbol / Color     | Meaning                                         |
|--------------------|-------------------------------------------------|
| `[GREEN] ●`        | Session running / active                        |
| `[GREY] ○`         | Session idle / paused                           |
| `[YELLOW] ●`       | Notification pending — needs approval           |
| `[ORANGE]` label   | Claude Code session or header                   |
| `[PURPLE]` label   | GitHub Copilot session or header                |
| `[CYAN]` label     | Codex CLI session or header                     |
| `[INVERT]` row     | Currently focused/selected session in left pane |
| `[YELLOW] █` fill  | Notification state — entire session row filled  |
| `[DIM]`            | Collapsed section label, inactive text          |
| `░░░░░░░░░░`       | Token budget bar (unfilled portion)             |
| `████████░░`       | Token budget bar (filled portion, green→yellow→red) |

---

## 2. Layout Anatomy

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  HEADER BAR — full width (130 cols)                                                                                              │
├────────────────────────────────────┬─────────────────────────────────────────────────────────────────────────────────────────────┤
│                                    │                                                                                             │
│  LEFT PANEL — 36 cols (fixed)      │  RIGHT PANEL — 93 cols (scrollable)                                                        │
│                                    │                                                                                             │
│  ┌ SESSIONS ─────────────────── ┐  │  ┌ session header ──────────────────────────────────────────────────────────────────────┐  │
│  │  ▼ Claude Code [CC]  [ORANGE]│  │  │  project [tool]  ── duration ── tokens ── edits ── session-id                       │  │
│  │    row row row               │  │  └──────────────────────────────────────────────────────────────────────────────────────┘  │
│  │  ▼ Copilot [CP]  [PURPLE]    │  │                                                                                             │
│  │    row row row               │  │  scrolling terminal output                                                                  │
│  │  ▶ Codex [CX]  [CYAN]        │  │  (tool calls, diffs, stdout, prompts)                                                       │
│  └──────────────────────────────┘  │                                                                                             │
│                                    │                                                                                             │
│  ┌ REVIEWS ──────────────────── ┐  │                                                                                             │
│  │  pending reviews              │  │                                                                                             │
│  └──────────────────────────────┘  │                                                                                             │
│                                    │                                                                                             │
│  ┌ MODEL ROUTING ─────────────── ┐ │                                                                                             │
│  │  agent  model  accuracy       │  │                                                                                             │
│  └──────────────────────────────┘  │                                                                                             │
│                                    │                                                                                             │
│  ┌ TOOLS ─────────────────────── ┐ │  $ _  (prompt line, bottom of right panel)                                                  │
│  │  top 3 vault tools            │  │                                                                                             │
│  └──────────────────────────────┘  │                                                                                             │
├────────────────────────────────────┴─────────────────────────────────────────────────────────────────────────────────────────────┤
│  BOTTOM BAR — full width (130 cols) — keybinding hints                                                                           │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Mockup 1 — Normal Working State (Claude Code session active)

**State:** Three sessions open (2x Claude Code, 1x Copilot). Active session is `PRGJSMES` Claude Code.  
Right panel shows live Claude Code output — Bash + Edit tool calls in progress.

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [WHITE/BOLD] vaultflow                    [GREEN] ● 3 sessions   Tokens: [GREEN]████████████░░░░░░░░  61,240 / 200,000  30%    │
├────────────────────────────────────────┬───────────────────────────────────────────────────────────────────────────────────────┤
│ SESSIONS                               │ [ORANGE] PRGJSMES [claude]  ── 00:14:32 ── 61,240 tok ── 7 edits ── s#2041           │
│ ▼ [ORANGE] Claude Code [CC]            ├───────────────────────────────────────────────────────────────────────────────────────┤
│ [INVERT][ORANGE] ● PRGJSMES     14m  [/]│                                                                                     │
│ [INVERT]   61k tok  7 edits  s#2041  [/]│  > Implement the customer search debounce on the order entry form                   │
│   [GREY] ○ Quoting       8m           │                                                                                       │
│     22k tok  2 edits  s#2040          │  [DIM] Reading CLAUDE.md...                                                           │
│                                        │  [DIM] Reading wiki/index.md...                                                      │
│ ▼ [PURPLE] Copilot [CP]                │                                                                                      │
│   [PURPLE] ● BUZZ           3m        │  ● Bash(20s)                                                                         │
│     8k tok   0 edits  s#2042          │  ┌─────────────────────────────────────────────────────────────────────────────────┐  │
│                                        │  │ $ grep -r "debounce" src/ --include="*.ts" -l                                   │  │
│ ▶ [CYAN] Codex [CX]   [DIM](1)        │  │ src/features/customer/customer-search.service.ts                                │  │
│                                        │  │ src/shared/utils/debounce.ts                                                    │  │
│ REVIEWS                                │  └─────────────────────────────────────────────────────────────────────────────────┘  │
│ ┌──────────────────────────────────┐   │                                                                                       │
│ │ [YELLOW] ⚠ 1 pending             │   │  ● Read(src/features/customer/customer-search.service.ts)                            │
│ │ plan review — PRGJSMES           │   │  ┌─────────────────────────────────────────────────────────────────────────────────┐  │
│ │ [DIM] voice-of-reason · 2m ago   │   │  │  1  import { Injectable } from '@angular/core';                                 │  │
│ └──────────────────────────────────┘   │  │  2  import { HttpClient } from '@angular/common/http';                          │  │
│                                        │  │  3  import { Subject } from 'rxjs';                                             │  │
│ MODEL ROUTING                          │  │  4  import { debounceTime, switchMap } from 'rxjs/operators';                   │  │
│ ┌──────────────────────────────────┐   │  │  5  ...                                                                         │  │
│ │ dev-fullstack  [YELLOW]opus→son  │   │  └─────────────────────────────────────────────────────────────────────────────────┘  │
│ │                97% ✓             │   │                                                                                       │
│ │ project-mgr  🔒 opus  (pinned)   │   │  ● Edit(src/features/order-entry/order-entry.component.ts)                           │
│ │ researcher   [GREEN]  son 100%✓  │   │  ┌─────────────────────────────────────────────────────────────────────────────────┐  │
│ │ voice-of-rsn [GREEN]  son  99%✓  │   │  │ [RED]  -  searchTerm: string = '';                                              │  │
│ └──────────────────────────────────┘   │  │ [RED]  -  onSearchChange(val: string) {                                         │  │
│                                        │  │ [RED]  -    this.loadCustomers(val);                                             │  │
│ TOOLS                                  │  │ [RED]  -  }                                                                      │  │
│ ┌──────────────────────────────────┐   │  │ [GREEN] +  private searchSubject = new Subject<string>();                        │  │
│ │ 1. db.cjs          ×38 this ses  │   │  │ [GREEN] +  ngOnInit() {                                                          │  │
│ │ 2. hook-handler    ×21 this ses  │   │  │ [GREEN] +    this.searchSubject.pipe(                                            │  │
│ │ 3. intelligence    ×14 this ses  │   │  │ [GREEN] +      debounceTime(300),                                                │  │
│ └──────────────────────────────────┘   │  │ [GREEN] +      switchMap(q => this.customerService.search(q))                   │  │
│                                        │  │ [GREEN] +    ).subscribe(results => this.customers = results);                  │  │
│                                        │  │ [GREEN] +  }                                                                     │  │
│                                        │  └─────────────────────────────────────────────────────────────────────────────────┘  │
│                                        │                                                                                       │
│                                        │  ● Bash(5s)                                                                          │
│                                        │  ┌─────────────────────────────────────────────────────────────────────────────────┐  │
│                                        │  │ $ ng build --configuration=production 2>&1 | tail -5                            │  │
│                                        │  │ ✔ Browser application bundle generation complete.                               │  │
│                                        │  │ Initial chunk files | Names         | Raw size                                  │  │
│                                        │  │ main.js             | main          |  312.41 kB                                │  │
│                                        │  │ Build at: 2026-05-05T18:42:11.302Z  - Hash: a9c2f1b                             │  │
│                                        │  └─────────────────────────────────────────────────────────────────────────────────┘  │
│                                        │                                                                                       │
│                                        │  [GREEN] Build successful. Debounce applied — 300ms delay on customer search.        │
│                                        │  The `searchSubject` Subject replaces the direct call. RxJS `switchMap` cancels      │
│                                        │  in-flight requests on rapid keystrokes. Pattern matches existing `order-search`     │
│                                        │  component at src/features/order/order-search.component.ts:47.                       │
│                                        │                                                                                       │
│                                        │  $ _                                                                                  │
├────────────────────────────────────────┴───────────────────────────────────────────────────────────────────────────────────────┤
│  Tab:focus  ↑↓:nav  Enter:open  N:new  K:kill  D:detach  Q:quit  /:search  R:reviews  M:models  ?:help                        │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Notes:**
- `[INVERT]` on the PRGJSMES rows = highlighted/selected, rendered as reversed fg/bg
- `[ORANGE]` applies to the Claude Code section header `▼ Claude Code [CC]`, the session rows, and the right panel header bar
- Token bar: green below 50%, yellow 50–80%, red 80%+
- `[YELLOW] ⚠ 1 pending` in REVIEWS blinks slowly (500ms on/off)
- Model routing `opus→son` means demoted from Opus to Sonnet; shown in `[YELLOW]`
- `🔒 opus (pinned)` means pinned — never demoted; shown in `[WHITE]`

---

## 4. Mockup 2 — Notification State (Session Awaiting Approval)

**State:** SubagentStop fired. The `PRGJSMES` session is paused waiting for voice-of-reason approval.  
Left panel session row fills `[YELLOW]` background. Right panel shows notification overlay on top of terminal output.

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [WHITE/BOLD] vaultflow                    [YELLOW] ⚠ AWAITING REVIEW   Tokens: [GREEN]████████████░░░░░░░░  61,240 / 200,000  │
├────────────────────────────────────────┬───────────────────────────────────────────────────────────────────────────────────────┤
│ SESSIONS                               │ [ORANGE] PRGJSMES [claude]  ── 00:14:51 ── 61,240 tok ── 7 edits ── s#2041           │
│ ▼ [ORANGE] Claude Code [CC]            ├───────────────────────────────────────────────────────────────────────────────────────┤
│ [YELLOW BG] ● PRGJSMES     14m  ⚠   [/]│                                                                                     │
│ [YELLOW BG]   61k tok  7 edits  s#2041[/│  [DIM] ● Bash(5s)                                                                  │
│   [GREY] ○ Quoting       8m           │  [DIM] ┌─────────────────────────────────────────────────────────────────────────┐   │
│     22k tok  2 edits  s#2040          │  [DIM] │ $ ng build --configuration=production 2>&1 | tail -5                     │   │
│                                        │  [DIM] │ Build at: 2026-05-05T18:42:11.302Z  - Hash: a9c2f1b                      │   │
│ ▼ [PURPLE] Copilot [CP]                │  [DIM] └─────────────────────────────────────────────────────────────────────────┘   │
│   [PURPLE] ● BUZZ           3m        │  [DIM]                                                                                │
│     8k tok   0 edits  s#2042          │  [DIM] [GREEN] Build successful. Debounce applied — 300ms delay...                   │
│                                        │  [DIM]                                                                               │
│ ▶ [CYAN] Codex [CX]   [DIM](1)        │  ╔══════════════════════════════════════════════════════════════════════════════════╗ │
│                                        │  ║ [YELLOW/BOLD] ⚠  PIPELINE REVIEW REQUIRED                                      ║ │
│ REVIEWS                                │  ║                                                                                  ║ │
│ ┌──────────────────────────────────┐   │  ║  Agent:    developer-fullstack                                                  ║ │
│ │ [YELLOW] ⚠ 1 pending [BLINK]     │   │  ║  Session:  s#2041 — PRGJSMES                                                   ║ │
│ │ plan review — PRGJSMES           │   │  ║  Trigger:  SubagentStop (plan execution complete)                               ║ │
│ │ voice-of-reason · just now       │   │  ║  Waiting:  voice-of-reason verdict                                             ║ │
│ └──────────────────────────────────┘   │  ║                                                                                  ║ │
│                                        │  ║  Summary of work:                                                               ║ │
│ MODEL ROUTING                          │  ║    • Modified 3 files                                                           ║ │
│ ┌──────────────────────────────────┐   │  ║    • Added debounce to order-entry search (300ms, RxJS switchMap)               ║ │
│ │ dev-fullstack  [YELLOW]opus→son  │   │  ║    • Build passed — 0 errors, 0 warnings                                       ║ │
│ │                97% ✓             │   │  ║    • Pattern matches existing order-search component                            ║ │
│ │ project-mgr  🔒 opus  (pinned)   │   │  ║                                                                                  ║ │
│ │ researcher   [GREEN]  son 100%✓  │   │  ║  Files changed:                                                                 ║ │
│ │ voice-of-rsn [GREEN]  son  99%✓  │   │  ║    [ORANGE] M  src/features/order-entry/order-entry.component.ts               ║ │
│ └──────────────────────────────────┘   │  ║    [ORANGE] M  src/features/order-entry/order-entry.component.html             ║ │
│                                        │  ║    [ORANGE] M  src/features/customer/customer-search.service.ts                ║ │
│ TOOLS                                  │  ║                                                                                  ║ │
│ ┌──────────────────────────────────┐   │  ║  ─────────────────────────────────────────────────────────────────────────     ║ │
│ │ 1. db.cjs          ×38 this ses  │   │  ║  [GREEN] A: Approve and continue   [RED] X: Block (open review)                ║ │
│ │ 2. hook-handler    ×21 this ses  │   │  ║  [DIM]   V: View full diff         S: Skip (no review)                        ║ │
│ │ 3. intelligence    ×14 this ses  │   │  ╚══════════════════════════════════════════════════════════════════════════════════╝ │
│                                        │                                                                                       │
│                                        │  $ _                                                                                  │
├────────────────────────────────────────┴───────────────────────────────────────────────────────────────────────────────────────┤
│  [YELLOW] ⚠ REVIEW PENDING  A:approve  X:block  V:view-diff  S:skip  Tab:focus  Q:quit                                        │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Notification state behavior:**
- The `[YELLOW BG]` fill covers the entire left-panel session row (both lines), not just the name
- The `⚠` symbol on the session row blinks at 1Hz in `[YELLOW]` on top of the yellow background
- Background terminal output (the `[DIM]` lines) is still visible but dimmed to 40% opacity
- The overlay box (`╔══╗`) is drawn on top in bright white with yellow title bar
- Bottom bar replaces normal keybindings with review-specific actions while overlay is focused
- Pressing `A` dismisses overlay, resumes session, turns row back to `[INVERT][ORANGE]`
- Pressing `X` opens a second overlay with the voice-of-reason full output and a text input for the block reason

---

## 5. Mockup 3 — New Session Launcher Dialog (N key)

**State:** User pressed `N`. A centered modal appears over the full TUI. Background TUI is dimmed.

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [DIM] vaultflow                          ● 3 sessions   Tokens: ████████████░░░░░░░░  61,240 / 200,000  30%                   │
├──────────────────────────────[DIM]───────────────────────────────────────────────────────────────────────────────────[DIM]────┤
│ [DIM] SESSIONS            [DIM]        │ [DIM] PRGJSMES [claude]  ── 00:15:20 ── 61,240 tok ── 7 edits ── s#2041 [DIM]       │
│ [DIM] ▼ Claude Code [CC]  [DIM]        ├─[DIM]─────────────────────────────────────────────────────────────────────[DIM]─────┤
│ [DIM]   ● PRGJSMES  14m   [DIM]        │ [DIM]                                                                     [DIM]      │
│ [DIM]   ○ Quoting    8m   [DIM]        │ [DIM]  Build successful. Debounce applied — 300ms delay...               [DIM]      │
│ [DIM] ▼ Copilot [CP]      [DIM]        │ [DIM]                                                                     [DIM]      │
│                                        │                                                                                       │
│         ┌───────────────────────────────────────────────────────────────────────────────┐                                    │
│         │ [WHITE/BOLD]  NEW SESSION                                                     │                                    │
│         │                                                                               │                                    │
│         │  Tool                                                                         │                                    │
│         │  ┌─────────────────────────────────────────────────────────────────────────┐ │                                    │
│         │  │ [ORANGE] ● claude           Claude Code (claude CLI)                    │ │                                    │
│         │  │ [PURPLE] ○ copilot          GitHub Copilot CLI (copilot)                │ │                                    │
│         │  │ [CYAN]   ○ codex            OpenAI Codex CLI (codex)                    │ │                                    │
│         │  └─────────────────────────────────────────────────────────────────────────┘ │                                    │
│         │                                                                               │                                    │
│         │  Project directory                                                            │                                    │
│         │  ┌─────────────────────────────────────────────────────────────────────────┐ │                                    │
│         │  │ C:\GIT\PRGJSMES_                                                        │ │                                    │
│         │  └─────────────────────────────────────────────────────────────────────────┘ │                                    │
│         │  [DIM] Recent: PRGJSMES  Quoting  BUZZ  vaultflow  InsuranceDB              │                                    │
│         │                                                                               │                                    │
│         │  Initial prompt  [DIM](optional — leave blank to open interactive shell)     │                                    │
│         │  ┌─────────────────────────────────────────────────────────────────────────┐ │                                    │
│         │  │ _                                                                       │ │                                    │
│         │  └─────────────────────────────────────────────────────────────────────────┘ │                                    │
│         │                                                                               │                                    │
│         │  Options                                                                      │                                    │
│         │  [GREEN] ☑  Attach to vaultflow session tracking                            │                                    │
│         │  [WHITE] ☐  Open in new terminal pane                                       │                                    │
│         │  [WHITE] ☐  Detached mode (background, no right pane)                       │                                    │
│         │                                                                               │                                    │
│         │  ─────────────────────────────────────────────────────────────────────────── │                                    │
│         │  [GREEN] Enter:launch    Esc:cancel    Tab:cycle tool    ↑↓:navigate         │                                    │
│         └───────────────────────────────────────────────────────────────────────────────┘                                    │
│                                        │                                                                                       │
├────────────────────────────────────────┴───────────────────────────────────────────────────────────────────────────────────────┤
│  [DIM] Tab:focus  ↑↓:nav  Enter:open  N:new  K:kill  D:detach  Q:quit                                                         │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Dialog behavior:**
- Dialog is centered horizontally and vertically — 85 cols wide, 22 rows tall
- Background TUI renders at `[DIM]` (40% opacity equivalent via color dimming)
- `Tab` cycles: Tool selector → Project dir input → Prompt input → Options checkboxes → Launch button
- `↑↓` navigates within the Tool selector list
- Tool selector is a single-select list — only one `●` active at a time
- Project directory has tab-completion from recent project list shown below input
- Clicking any `[DIM] Recent:` project name fills the project dir input
- `Enter` when on tool selector selects and advances to project dir
- `Enter` when on project dir or prompt input advances to next field
- `Enter` when cursor is outside a text field = launch
- `Esc` anywhere in dialog = cancel, return to normal TUI
- On launch: dialog closes, new session row appears in left panel, right panel switches to new session

---

## 6. Mockup 4 — Session Switching (Multiple Sessions, Switching Between Them)

**State:** 4 sessions open (2x CC, 1x CP, 1x CX). User is navigating the session list — `Quoting` is highlighted, right panel shows Quoting session output.

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [WHITE/BOLD] vaultflow                    [GREEN] ● 4 sessions   Tokens: [YELLOW]████████████████░░░░  87,440 / 200,000  43%  │
├────────────────────────────────────────┬───────────────────────────────────────────────────────────────────────────────────────┤
│ SESSIONS                               │ [ORANGE] Quoting [claude]  ── 00:08:03 ── 22,310 tok ── 2 edits ── s#2040            │
│ ▼ [ORANGE] Claude Code [CC]            ├───────────────────────────────────────────────────────────────────────────────────────┤
│   [ORANGE] ● PRGJSMES     14m          │                                                                                       │
│     61k tok  7 edits  s#2041          │  > Fix the InsuranceQuote premium calculation to handle null deductible               │
│ [INVERT][ORANGE] ○ Quoting       8m [/]│                                                                                       │
│ [INVERT]   22k tok  2 edits  s#2040[/] │  ● Read(src/QuoteEngine/PremiumCalculator.cs)                                        │
│                                        │  ┌─────────────────────────────────────────────────────────────────────────────────┐  │
│ ▼ [PURPLE] Copilot [CP]                │  │   87   public decimal Calculate(QuoteRequest request) {                         │  │
│   [PURPLE] ● BUZZ           5m        │  │   88       var base = request.CoverageAmount * _rateTable[request.PlanCode];     │  │
│     9k tok   1 edit   s#2042          │  │   89       var deductible = request.Deductible ?? 0m;                            │  │
│                                        │  │   90       return base * (1 - (deductible / 10000m));                           │  │
│ ▼ [CYAN] Codex [CX]                    │  │   91   }                                                                        │  │
│   [CYAN] ● vaultflow        2m        │  └─────────────────────────────────────────────────────────────────────────────────┘  │
│     4k tok   0 edits  s#2043          │                                                                                       │
│                                        │  The null coalescing on line 89 already handles null deductible (`?? 0m`).           │
│ REVIEWS                                │  Running the failing test to reproduce:                                               │
│ ┌──────────────────────────────────┐   │                                                                                       │
│ │ [GREEN] ✓ No pending reviews     │   │  ● Bash(8s)                                                                         │
│ └──────────────────────────────────┘   │  ┌─────────────────────────────────────────────────────────────────────────────────┐  │
│                                        │  │ $ dotnet test --filter "PremiumCalculator" --logger "console;verbosity=normal"  │  │
│ MODEL ROUTING                          │  │                                                                                   │  │
│ ┌──────────────────────────────────┐   │  │  Determining projects to restore...                                             │  │
│ │ dev-fullstack  [YELLOW]opus→son  │   │  │  Build succeeded.                                                               │  │
│ │                97% ✓             │   │  │                                                                                   │  │
│ │ project-mgr  🔒 opus  (pinned)   │   │  │  Failed  PremiumCalculatorTests.Calculate_NullDeductible_ReturnsFullPremium      │  │
│ │ researcher   [GREEN]  son 100%✓  │   │  │    Expected: 1250.00                                                            │  │
│ │ voice-of-rsn [GREEN]  son  99%✓  │   │  │    Actual:   1250.125                                                           │  │
│ └──────────────────────────────────┘   │  │                                                                                   │  │
│                                        │  │  Failed! - Failed: 1, Passed: 12, Skipped: 0, Total: 13                         │  │
│ TOOLS                                  │  └─────────────────────────────────────────────────────────────────────────────────┘  │
│ ┌──────────────────────────────────┐   │                                                                                       │
│ │ 1. db.cjs          ×38 all ses   │   │  The issue is a floating-point precision error in the deductible ratio. The          │  │
│ │ 2. hook-handler    ×21 all ses   │   │  deductible discount formula divides by `10000m` but the test expects integer        │  │
│ │ 3. PremiumCalc     ×8 s#2040     │   │  rounding. Fixing with `Math.Round(..., 2, MidpointRounding.AwayFromZero)`.          │  │
│ └──────────────────────────────────┘   │                                                                                       │
│                                        │  ● Edit(src/QuoteEngine/PremiumCalculator.cs)                                        │
│                                        │  ┌─────────────────────────────────────────────────────────────────────────────────┐  │
│                                        │  │ [RED]  -    return base * (1 - (deductible / 10000m));                          │  │
│                                        │  │ [GREEN] +    var discount = Math.Round(deductible / 10000m, 4);                  │  │
│                                        │  │ [GREEN] +    return Math.Round(base * (1 - discount), 2,                        │  │
│                                        │  │ [GREEN] +        MidpointRounding.AwayFromZero);                                │  │
│                                        │  └─────────────────────────────────────────────────────────────────────────────────┘  │
│                                        │                                                                                       │
│                                        │  $ _                                                                                  │
├────────────────────────────────────────┴───────────────────────────────────────────────────────────────────────────────────────┤
│  Tab:focus  ↑↓:nav  Enter:open  N:new  K:kill  D:detach  Q:quit  /:search  R:reviews  M:models  ?:help                        │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Session switching behavior:**
- `↑↓` navigates the session list — `[INVERT]` highlight moves with cursor
- Right panel **does not switch** on cursor movement — it only switches on `Enter`
- This prevents flicker when quickly scanning the list
- `Enter` on a session row: right panel immediately switches to that session's output, scrolled to bottom
- Clicking a left-panel session row with mouse = same as Enter (focus + switch)
- When switching: right panel header bar updates to new session's metadata
- Token bar in header updates to new session's token count
- The previously-viewed session's scroll position is preserved — returning to it restores position
- Idle sessions (`○`) show the last-seen output, not a live feed (grey border on right panel header)
- Running sessions (`●`) show live-tailed output — new lines append as they arrive

---

## 7. Mockup 5 — Right Panel: Copilot Session

**State:** BUZZ Copilot session active in right panel. `[PURPLE]` header. Shows `gh copilot suggest` flow.

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [WHITE/BOLD] vaultflow                    [GREEN] ● 3 sessions   Tokens: [PURPLE]████░░░░░░░░░░░░░░░░  9,100 / 200,000   4%  │
├────────────────────────────────────────┬───────────────────────────────────────────────────────────────────────────────────────┤
│ SESSIONS                               │ [PURPLE] BUZZ [gh copilot]  ── 00:05:22 ── 9,100 tok ── 1 edit ── s#2042             │
│ ▼ [ORANGE] Claude Code [CC]            ├───────────────────────────────────────────────────────────────────────────────────────┤
│   [ORANGE] ● PRGJSMES     14m          │                                                                                       │
│     61k tok  7 edits  s#2041          │  $ gh copilot suggest "add a git pre-commit hook that runs eslint on staged files"     │
│   [GREY] ○ Quoting       8m           │                                                                                       │
│     22k tok  2 edits  s#2040          │  Welcome to GitHub Copilot in the CLI!                                                 │
│                                        │  version 1.0.6 (2026-03-14)                                                           │
│ ▼ [PURPLE] Copilot [CP]                │                                                                                       │
│ [INVERT][PURPLE] ● BUZZ     5m    [/]  │  I'm powered by AI, so surprises and mistakes are possible.                          │
│ [INVERT]   9k tok  1 edit s#2042 [/]   │  Read more: https://gh.io/gh-copilot                                                  │
│                                        │                                                                                       │
│ ▶ [CYAN] Codex [CX]   [DIM](1)        │  ? What kind of command can I help you with?                                          │
│                                        │  ❯ git                                                                                │
│ REVIEWS                                │    gh                                                                                 │
│ ┌──────────────────────────────────┐   │    shell                                                                              │
│ │ [GREEN] ✓ No pending reviews     │   │                                                                                       │
│ └──────────────────────────────────┘   │  [PURPLE] Suggestion:                                                                 │
│                                        │                                                                                       │
│ MODEL ROUTING                          │  ┌─────────────────────────────────────────────────────────────────────────────────┐  │
│ ┌──────────────────────────────────┐   │  │ #!/bin/sh                                                                       │  │
│ │ dev-fullstack  [YELLOW]opus→son  │   │  │ # .git/hooks/pre-commit                                                         │  │
│ │                97% ✓             │   │  │ STAGED=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.(js|ts)$')│  │
│ │ project-mgr  🔒 opus  (pinned)   │   │  │ if [ -n "$STAGED" ]; then                                                       │  │
│ │ researcher   [GREEN]  son 100%✓  │   │  │   echo "$STAGED" | xargs ./node_modules/.bin/eslint                             │  │
│ │ voice-of-rsn [GREEN]  son  99%✓  │   │  │   if [ $? -ne 0 ]; then                                                         │  │
│ └──────────────────────────────────┘   │  │     echo "ESLint failed. Commit aborted."                                       │  │
│                                        │  │     exit 1                                                                      │  │
│ TOOLS                                  │  │   fi                                                                             │  │
│ ┌──────────────────────────────────┐   │  │ fi                                                                               │  │
│ │ 1. db.cjs          ×38 all ses   │   │  └─────────────────────────────────────────────────────────────────────────────────┘  │
│ │ 2. hook-handler    ×21 all ses   │   │                                                                                       │
│ │ 3. intelligence    ×14 all ses   │   │  ? Select an option                                                                   │
│ └──────────────────────────────────┘   │  ❯ Copy command to clipboard                                                         │
│                                        │    Explain command                                                                    │
│                                        │    Revise command                                                                     │
│                                        │    Rate response                                                                      │
│                                        │    Exit                                                                               │
│                                        │                                                                                       │
│                                        │  [PURPLE] ✓ Copied to clipboard                                                      │
│                                        │                                                                                       │
│                                        │  $ gh copilot explain "git rebase --onto"                                             │
│                                        │                                                                                       │
│                                        │  [PURPLE] Explanation:                                                                │
│                                        │  `git rebase --onto <newbase> <upstream> <branch>` replants the commits               │
│                                        │  from <upstream>...<branch> onto <newbase>. Useful for moving a feature               │
│                                        │  branch from one base to another without replaying the base commits.                  │
│                                        │                                                                                       │
│                                        │  Example: you branched `feat/x` from `dev`, but want it on `main`:                   │
│                                        │    git rebase --onto main dev feat/x                                                  │
│                                        │                                                                                       │
│                                        │  $ _                                                                                  │
├────────────────────────────────────────┴───────────────────────────────────────────────────────────────────────────────────────┤
│  Tab:focus  ↑↓:nav  Enter:open  N:new  K:kill  D:detach  Q:quit  /:search  R:reviews  M:models  ?:help                        │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Copilot session notes:**
- `[PURPLE]` header bar on the right panel
- Copilot output uses its actual CLI format: `?` prompts, `❯` selection indicator, interactive menus
- vaultflow captures this output via the watcher daemon (chokidar), not via Claude Code hooks
- Token count for Copilot sessions is estimated from character count (no native API for CP usage)
- Edit count tracks actual file writes, same as CC sessions

---

## 8. Mockup 6 — Right Panel: Codex Session

**State:** vaultflow Codex session active. `[CYAN]` header. Shows `codex` CLI output.

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [WHITE/BOLD] vaultflow                    [GREEN] ● 3 sessions   Tokens: [CYAN]██░░░░░░░░░░░░░░░░░░  4,200 / 200,000    2%   │
├────────────────────────────────────────┬───────────────────────────────────────────────────────────────────────────────────────┤
│ SESSIONS                               │ [CYAN] vaultflow [codex]  ── 00:02:11 ── 4,200 tok ── 0 edits ── s#2043              │
│ ▼ [ORANGE] Claude Code [CC]            ├───────────────────────────────────────────────────────────────────────────────────────┤
│   [ORANGE] ● PRGJSMES     14m          │                                                                                       │
│     61k tok  7 edits  s#2041          │  $ codex "audit the hook-handler.cjs file for any tool call deduplication gaps"        │
│   [GREY] ○ Quoting       8m           │                                                                                       │
│     22k tok  2 edits  s#2040          │  [CYAN] codex v0.1.2504 — powered by o4-mini                                          │
│                                        │                                                                                       │
│ ▼ [PURPLE] Copilot [CP]                │  Working in: C:\GIT\vaultflow                                                         │
│   [PURPLE] ● BUZZ           5m        │  Auto-approval: off  |  Sandbox: on                                                    │
│     9k tok   1 edit   s#2042          │                                                                                       │
│                                        │  [CYAN] ● Reading files...                                                            │
│ ▼ [CYAN] Codex [CX]                    │                                                                                       │
│ [INVERT][CYAN] ● vaultflow   2m   [/]  │   cat .claude/helpers/hook-handler.cjs                                                │
│ [INVERT]   4k tok  0 edits s#2043[/]   │                                                                                       │
│                                        │  [CYAN] ● Analyzing...                                                                │
│ REVIEWS                                │                                                                                       │
│ ┌──────────────────────────────────┐   │  [WHITE/BOLD] Findings:                                                               │
│ │ [GREEN] ✓ No pending reviews     │   │                                                                                       │
│ └──────────────────────────────────┘   │  1. [YELLOW] GAP — processToolCall() (line 241)                                       │
│                                        │     Deduplication key is `${toolName}:${JSON.stringify(args)}` but args are           │
│ MODEL ROUTING                          │     not sorted before stringify. Object `{b:1,a:2}` and `{a:2,b:1}` produce           │
│ ┌──────────────────────────────────┐   │     different keys, allowing duplicate calls to slip through.                         │
│ │ dev-fullstack  [YELLOW]opus→son  │   │     [GREEN] Fix: sort object keys before stringify, or use a canonical hash.          │
│ │                97% ✓             │   │                                                                                       │
│ │ project-mgr  🔒 opus  (pinned)   │   │  2. [GREEN] OK — sessionGuard() (line 89)                                            │
│ │ researcher   [GREEN]  son 100%✓  │   │     TTL-based dedup with 30s window. No gaps found.                                   │
│ │ voice-of-rsn [GREEN]  son  99%✓  │   │                                                                                       │
│ └──────────────────────────────────┘   │  3. [YELLOW] GAP — handleSubagentStop() (line 318)                                    │
│                                        │     No dedup at all. If SubagentStop fires twice in rapid succession                  │
│ TOOLS                                  │     (observed in multi-agent pipelines), two review overlays spawn.                   │
│ ┌──────────────────────────────────┐   │     [GREEN] Fix: add a per-session mutex keyed on session_id.                         │
│ │ 1. db.cjs          ×38 all ses   │   │                                                                                       │
│ │ 2. hook-handler    ×21 all ses   │   │  [WHITE/BOLD] Summary: 2 gaps found, 1 clean.                                         │
│ │ 3. intelligence    ×14 all ses   │   │  Confidence: high — full file read, patterns cross-referenced.                        │
│ └──────────────────────────────────┘   │                                                                                       │
│                                        │  [CYAN] ● Generating patch...                                                         │
│                                        │                                                                                       │
│                                        │   patch .claude/helpers/hook-handler.cjs                                              │
│                                        │                                                                                       │
│                                        │  [DIM] (sandbox — changes staged, not applied)                                       │
│                                        │  [DIM] Apply patch? [y/N]: _                                                         │
│                                        │                                                                                       │
│                                        │  $ _                                                                                  │
├────────────────────────────────────────┴───────────────────────────────────────────────────────────────────────────────────────┤
│  Tab:focus  ↑↓:nav  Enter:open  N:new  K:kill  D:detach  Q:quit  /:search  R:reviews  M:models  ?:help                        │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Codex session notes:**
- `[CYAN]` header bar on right panel
- Codex CLI output format: brief preamble, `● Reading files...` spinner, findings in numbered list
- Codex runs in sandbox mode by default — patches staged but not applied without `y` confirm
- vaultflow tracks Codex sessions via the watcher daemon monitoring `.codex/` output files
- Session token count comes from Codex's own `--usage` output line (parsed by watcher)

---

## 9. Interaction Reference

### Keyboard

| Key         | Action                                                                |
|-------------|-----------------------------------------------------------------------|
| `Tab`       | Toggle focus between left panel and right panel                       |
| `↑` / `↓`  | Navigate session list (left panel focus) or scroll output (right panel focus) |
| `Enter`     | Open focused session in right panel                                   |
| `N`         | Open New Session dialog (always works, regardless of focus)           |
| `K`         | Kill focused session (prompts: `Kill session PRGJSMES? [y/N]`)        |
| `D`         | Detach focused session (keeps running, removes from list)             |
| `Q`         | Quit TUI — all sessions keep running in background                    |
| `/`         | Search sessions by project name (filter left panel in real time)      |
| `R`         | Jump focus to REVIEWS section                                         |
| `M`         | Jump focus to MODEL ROUTING section (cycle models with `←→`)          |
| `Space`     | Scroll right panel down one page                                      |
| `G`         | Scroll right panel to bottom (live tail)                              |
| `g g`       | Scroll right panel to top                                             |
| `A`         | Approve notification (when review overlay is visible)                 |
| `X`         | Block notification (when review overlay is visible)                   |
| `V`         | View full diff (when review overlay is visible)                       |
| `Esc`       | Close dialog / dismiss overlay / cancel search                        |
| `?`         | Toggle keybinding help overlay                                        |
| `1`–`9`    | Jump directly to session by position in list                          |

### Mouse

| Action                              | Result                                                     |
|-------------------------------------|------------------------------------------------------------|
| Click session row (left panel)      | Select + open in right panel                               |
| Double-click session row            | Open session + switch focus to right panel                 |
| Scroll (left panel)                 | Scroll session list if more sessions than visible rows     |
| Scroll (right panel)                | Scroll terminal history up/down                            |
| Click right panel                   | Focus right panel (enables keyboard scroll)                |
| Click `▼` / `▶` section header     | Collapse / expand that group                               |
| Click `[ORANGE] ●` session dot     | No-op (cosmetic indicator only)                            |

---

## 10. Left Panel Section Details

### SESSIONS section

```
SESSIONS
├── ▼ [ORANGE] Claude Code [CC]          ← collapsible group header, click ▼ to collapse
│   ├── [INVERT][ORANGE] ● PRGJSMES  14m ← active (highlighted/inverted), running (green dot)
│   │       61k tok  7 edits  s#2041     ← second line of session row (same highlight)
│   └── [GREY] ○ Quoting      8m        ← idle, grey dot
│           22k tok  2 edits  s#2040
├── ▼ [PURPLE] Copilot [CP]              ← collapsed when ▶
│   └── [PURPLE] ● BUZZ       5m
│           9k tok  1 edit  s#2042
└── ▶ [CYAN] Codex [CX]  [DIM](1)       ← collapsed — shows count in parens
```

**Session row fields (2 lines per session):**
- Line 1: `[dot] [project-name]  [duration]`
- Line 2: `  [token-count]  [edit-count]  [session-id]`
- Total width: 34 chars (fits in 36-wide panel with 1-char padding each side)
- Notification state: both lines fill `[YELLOW BG]`, dot changes to `[YELLOW] ●`, `⚠` appended

### REVIEWS section

```
REVIEWS
┌──────────────────────────────────┐
│ [YELLOW] ⚠ 2 pending             │   ← count badge, blinks when > 0
│ plan review  PRGJSMES  2m ago    │   ← most urgent review shown
│ code review  Quoting   5m ago    │   ← second review
└──────────────────────────────────┘
```

- Shows up to 2 reviews inline; overflow shown as `+ N more`
- `[GREEN] ✓ No pending reviews` when queue empty
- Clicking a review row opens the review overlay on the right panel for that session

### MODEL ROUTING section

```
MODEL ROUTING
┌──────────────────────────────────┐
│ dev-fullstack  [YEL]opus→son 97% │   ← demoted: was opus, running on sonnet, 97% approval
│ project-mgr  🔒 opus  (pinned)   │   ← pinned: never demoted
│ researcher   [GRN] son    100%   │   ← promoted: running on sonnet, perfect record
│ voice-of-rsn [GRN] son     99%   │
│ reviewer-cod [GRN] hku     94%   │   ← haiku (cost-optimized for reviews)
└──────────────────────────────────┘
```

- Arrow `→` shows demotion direction: `opus→son`, `son→hku`
- `🔒` = pinned, no demotion regardless of accuracy
- `%` = approval rate over last 20 runs
- Color: `[GREEN]` ≥ 95%, `[YELLOW]` 80–94%, `[RED]` < 80%

### TOOLS section

```
TOOLS
┌──────────────────────────────────┐
│ 1. db.cjs          ×38 this ses  │   ← call count this session
│ 2. hook-handler    ×21 this ses  │
│ 3. intelligence    ×14 this ses  │
└──────────────────────────────────┘
```

- Shows top 3 vault tools by call frequency in the currently-viewed session
- `this ses` = current session; `all ses` = aggregate across all open sessions (when no session focused)
- Clicking a tool row opens vault tool detail in right panel (read-only info pane)

---

## 11. Right Panel Header Variants

### Claude Code (active, running)

```
[ORANGE] PRGJSMES [claude]  ── 00:14:32 ── 61,240 tok ── 7 edits ── s#2041  [GREEN] ● LIVE
```

### Copilot (active, running)

```
[PURPLE] BUZZ [gh copilot]  ── 00:05:22 ── 9,100 tok ── 1 edit ── s#2042  [GREEN] ● LIVE
```

### Codex (active, running)

```
[CYAN] vaultflow [codex]  ── 00:02:11 ── 4,200 tok ── 0 edits ── s#2043  [GREEN] ● LIVE
```

### Any tool (idle / viewed but not active)

```
[GREY] Quoting [claude]  ── 00:08:03 ── 22,310 tok ── 2 edits ── s#2040  [GREY] ○ IDLE
```

### Notification pending

```
[YELLOW] PRGJSMES [claude]  ── 00:14:51 ── 61,240 tok ── 7 edits ── s#2041  [YELLOW] ⚠ REVIEW
```

---

## 12. Token Budget Bar Specification

The header bar token usage display:

```
Tokens: [COLOR]████████████░░░░░░░░  61,240 / 200,000  30%
         ├─ filled (12 blocks) ──┤├── empty (8 blocks) ─┤
```

- Bar is 20 blocks wide total
- Filled blocks = `Math.floor(pct / 5)` (5% per block)
- Color of filled blocks:
  - 0–50%: `[GREEN]`
  - 51–80%: `[YELLOW]`
  - 81–100%: `[RED]`
- Empty blocks: `[DIM]` (grey)
- Shows token count for the currently-focused session (left panel selection)
- If no session focused: shows session with highest token usage

---

## 13. Keybinding Help Overlay (`?` key)

Pressing `?` draws a centered help overlay. Width 70 cols, height ~26 rows.

```
         ┌──────────────────────────────────────────────────────────────────────┐
         │ [WHITE/BOLD]  vaultflow TUI — Keybindings                           │
         ├──────────────────────────────────────────────────────────────────────┤
         │  Navigation                                                          │
         │    Tab          Switch focus: left panel ↔ right panel              │
         │    ↑ / ↓        Navigate sessions (left) or scroll output (right)   │
         │    Enter        Open session in right panel                         │
         │    1–9          Jump to session by position                         │
         │    /            Search sessions (filter left panel)                 │
         │                                                                      │
         │  Session Actions                                                     │
         │    N            New session dialog                                  │
         │    K            Kill session (prompts for confirmation)             │
         │    D            Detach session (background, remove from list)       │
         │    Q            Quit TUI (sessions keep running)                    │
         │                                                                      │
         │  Right Panel                                                         │
         │    Space        Scroll down one page                                │
         │    G            Jump to bottom (live tail)                          │
         │    g g          Jump to top                                         │
         │                                                                      │
         │  Reviews                                                             │
         │    R            Jump to REVIEWS section                             │
         │    A            Approve (when review overlay shown)                 │
         │    X            Block (when review overlay shown)                   │
         │    V            View diff (when review overlay shown)               │
         │                                                                      │
         │  Other                                                               │
         │    M            Jump to MODEL ROUTING section                       │
         │    Esc          Close dialog / cancel                               │
         │    ?            Toggle this help                                    │
         ├──────────────────────────────────────────────────────────────────────┤
         │  [DIM] Press any key to dismiss                                     │
         └──────────────────────────────────────────────────────────────────────┘
```

---

## 14. Collapsed Left Panel State

When left panel is fully collapsed (e.g., `D` detach leaves 0 CC sessions), groups show with `▶`:

```
SESSIONS
▶ [ORANGE] Claude Code [CC]  [DIM](0)
▶ [PURPLE] Copilot [CP]      [DIM](2)
▶ [CYAN]   Codex [CX]        [DIM](1)
```

- Clicking `▶` expands the group (becomes `▼`) and shows sessions under it
- `(0)` groups are still shown — useful for launching a new session of that tool type
- When all groups collapsed, left panel shows REVIEWS / MODEL ROUTING / TOOLS sections with more vertical space

---

## 15. Edge Cases

### No sessions open (fresh start)

```
SESSIONS
  [DIM] No active sessions
  Press N to start one
```

Right panel shows:
```
[DIM/CENTERED]
  vaultflow
  No session open.
  Press N to launch one, or click a session in the left panel.
```

### Session crash / unexpected exit

Left panel row:
```
[RED] ✗ PRGJSMES     14m
  61k tok  7 edits  s#2041  [BLINK][RED] CRASHED
```

Right panel shows last output, then:
```
[RED] ✗ Session s#2041 exited unexpectedly (exit code 1)
[DIM] Last 5 lines preserved above. Press K to remove or Enter to restart.
```

### Very long session list (> visible rows)

Left panel scrolls independently when focused. A subtle scroll indicator appears on the right edge:
```
▲   ← top indicator (shows if scrolled down)
│
│  session rows
│
▼   ← bottom indicator (shows if more below)
```

### Network/DB error

Header bar status changes to:
```
[RED] ✗ DB error  vaultflow                [RED] ● db.cjs unreachable
```

Session tracking pauses but tool output continues. Error detail shown in a slim banner below header.

---

*End of mockup document. All widths assume 130-column terminal. Box drawing characters require a terminal font with Unicode support (e.g., Cascadia Code, JetBrains Mono, or any Nerd Font).*
