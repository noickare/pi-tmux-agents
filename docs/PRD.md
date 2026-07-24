# PRD: Persistent tmux Subagents for Pi

**Date:** 2026-07-23  
**Status:** Approved  
**Type:** Feature

## Problem Statement

Pi’s existing subagent example provides isolated child processes and streamed results, but operators cannot directly inspect or interact with persistent child sessions. We need persistent, steerable subagents with readable tmux sessions, autonomous parent supervision, worktree isolation, resource-aware scheduling, restart recovery, and a polished TUI.

## Goals

1. Run persistent pi agents in isolated tmux windows.
2. Allow repeated prompts, steering, follow-ups, aborts, restarts, and replacement.
3. Give the parent agent full orchestration authority over children.
4. Provide structured progress without relying on terminal scraping.
5. Isolate mutating agents in Git worktrees.
6. Dynamically schedule agents according to system resources.
7. Detect stuck, failed, orphaned, or resource-constrained agents.
8. Provide an accessible dashboard, progress widget, and supervision timer.
9. Recover live agents after parent restart or `/reload`.
10. Make the TUI and extension internals pleasant to use, maintain, test, and extend.

## Non-Goals

- Distributed execution across machines
- Native Windows support outside WSL
- Web monitoring
- Silent dependency installation or configuration changes
- Automatic remote pushes or destructive remote Git operations
- Automatic PR creation in the first release

## Current State

Pi includes:

- `examples/extensions/subagent/index.ts`: isolated subagent execution, parallel and chained modes, streaming updates, rendering, and usage accounting
- `docs/rpc.md`: structured prompting, steering, follow-up, abort, lifecycle, tool, retry, and compaction events
- `docs/tui.md`: overlays, widgets, custom components, focus, keyboard handling, and theming
- `examples/extensions/interactive-shell.ts`: safe TUI suspension for interactive terminal programs
- `docs/tmux.md`: recommended extended-key configuration

The existing subagent example is one-shot and directly captures JSON output. It has no persistent control channel, tmux lifecycle, resource scheduler, watchdog, worktree manager, or operator dashboard.

## Proposed Architecture

```text
Parent pi
└── tmux-agents extension
    ├── orchestration tools
    ├── resource scheduler
    ├── watchdog
    ├── state/event store
    ├── worktree manager
    └── TUI dashboard/widget
             │
             ▼
    tmux session: pi-agents-<parent-id>
    ├── scout-1  → runner → pi --mode rpc
    ├── worker-2 → runner → pi --mode rpc
    └── review-1 → runner → pi --mode rpc
```

### Parent extension

- Registers tools and `/agents` commands.
- Creates and discovers tmux sessions.
- Watches structured child state.
- Schedules work based on resources and priority.
- Runs supervisory parent checks.
- Restores state after reload or restart.
- Renders progress and accepts operator actions.

### Child runner

Each tmux window runs a bundled TypeScript runner that:

- Starts `pi --mode rpc`.
- Maintains a persistent pi session.
- Converts RPC events into a readable terminal transcript.
- Writes structured events and atomic snapshots.
- Receives durable commands from the parent.
- Sends prompts, steering, and follow-ups.
- Handles RPC extension dialogs according to configured policy.
- Emits heartbeats even when the model is waiting.
- Survives disconnection from the parent extension.

### Durable control channel

```text
~/.pi/agent/subagents/<parent-session-id>/<agent-id>/
├── agent.json
├── commands.jsonl
├── events.jsonl
├── snapshot.json
├── result.json
├── runner.log
└── transcript.log
```

- Parent is the sole writer of `commands.jsonl`.
- Runner is the sole writer of `events.jsonl`.
- Snapshots use temporary-file-plus-rename atomic updates.
- Commands and events have stable IDs for idempotent replay.
- Files use restrictive permissions.
- Session entries persist lightweight references rather than full logs.

## Agent Lifecycle

```text
creating → queued → starting → idle ↔ running
                                 ├── waiting
                                 ├── retrying
                                 ├── compacting
                                 ├── paused
                                 ├── blocked
                                 └── aborting

Terminal:
completed | failed | replaced | closed | orphaned
```

A persistent agent returns to `idle` after completing an assignment. It remains available for more instructions until explicitly closed or its configurable idle timeout expires.

### Message routing

- Idle agent and instruction → RPC `prompt`
- Running agent and immediate correction → RPC `steer`
- Running agent and later task → RPC `follow_up`
- Paused agent → durable queue until resumed
- Disconnected runner → retain command until recovery
- Duplicate command ID → ignore safely

## Parent Orchestration

The parent agent can:

- Create predefined or ad-hoc children
- Assign and reprioritize tasks
- Inspect status, transcript, session, diff, and commits
- Send multiple steering or follow-up messages
- Pause, resume, abort, restart, replace, or close agents
- Request fixes or delegate reviews
- Perform fixes itself
- Run validation
- Resolve ordinary conflicts
- Merge child branches locally
- Clean completed worktrees

Remote pushes, force pushes, destructive resets, and remote deletion remain subject to normal safety controls.

## Git Worktrees

- Every mutating agent receives a dedicated branch and worktree.
- Read-only agents may share the parent working directory.
- Worktrees live under a configurable sibling `.worktrees` directory.
- Agent identity records branch, base commit, worktree path, and current commit.
- Cleanup requires a clean worktree or explicit discard decision.
- Parent decides whether to request fixes, merge, cherry-pick, take over, or discard.
- Parallel agents never edit the same physical worktree.

## Resource-Aware Scheduler

There is no fixed concurrency count. Admission uses:

- CPU count and load
- Available memory
- Disk availability
- Existing child process usage
- Parent resource reservation
- Task resource classification
- Active builds and test processes
- Provider retry and rate-limit signals
- User-configured thresholds

Normal pressure queues new work. Critical pressure may pause lower-priority agents using platform process-group controls. The scheduler prioritizes interactive parent work, near-complete agents, merge-critical work, normal workers, then speculative work. Paused agents resume automatically when capacity returns.

## Watchdog and Supervision

### Lightweight watchdog

Runs every 15–30 seconds without invoking a model and checks:

- Runner heartbeat
- RPC child process
- tmux session and window existence
- Last event and meaningful-progress timestamps
- Worktree and branch validity
- Disk and memory pressure
- Queue health
- Repeated retries or tool failures
- Unanswered extension UI requests
- Parent/child state inconsistencies

### Parent supervisory review

Default: every five minutes while children are active. The TUI shows the next review time and whether it is overdue.

The extension sends a compact consolidated report to the parent. The parent can inspect, steer, restart, replace, take over, merge, or close children.

Potentially stuck agents receive:

1. A diagnostic steering message
2. A grace period
3. Parent review
4. Checkpoint and restart or replacement if still stuck

Replacement agents inherit the task, progress summary, relevant session context, branch, and worktree state.

## TUI and User Experience

The TUI is a required implementation track, not optional polish. It uses pi's public extension and TUI APIs rather than private internals.

### Pi customization APIs

- `ctx.ui.custom()` for focused components and overlays
- Dynamic `overlayOptions` for responsive positioning
- `ctx.ui.setWidget()` for persistent progress
- `ctx.ui.setStatus()` for footer-compatible status
- `renderCall` and `renderResult` for streaming tools
- `SelectList` for agent selection and filtering
- `SettingsList` for configuration
- `Input` and `Editor` for steering
- `BorderedLoader` for cancellable operations
- `DynamicBorder`, `Container`, `Text`, `Markdown`, and `Spacer`
- `Focusable` and `CURSOR_MARKER` for IME behavior
- `matchesKey()`, `Key`, `keyHint()`, and injected keybindings
- `truncateToWidth()`, `visibleWidth()`, and `wrapTextWithAnsi()`
- `tui.requestRender()`, invalidation, and disposal
- Overlay handles for focus, hiding, and stacking

### Design principles

#### Progressive disclosure

1. **Widget:** compact overall status and supervision countdown
2. **Dashboard:** structured monitoring and actions
3. **tmux:** complete live transcript and direct terminal inspection

Users should not need to enter tmux for routine monitoring.

#### Preserve native pi behavior

The extension does not replace pi's editor or footer by default. It composes through widgets, statuses, temporary overlays, tool renderers, and notifications so it remains compatible with themes, custom editors, and other extensions.

#### Stable live updates

- Coalesce rapid RPC events before rendering.
- Preserve selected agent by ID rather than list index.
- Keep stable sorting unless the user changes it.
- Update timers at most once per second.
- Reuse renderer components through `context.lastComponent`.
- Cache output and invalidate only when necessary.
- Call `tui.requestRender()` after meaningful state changes.

#### Responsive behavior

- Wide terminals: right-side dashboard
- Medium terminals: centered dashboard using most of the viewport
- Narrow terminals: nearly full-width focused view
- Very narrow terminals: compact single-column layout

Every rendered line must satisfy `visibleWidth(line) <= supplied render width`. Long tasks, branches, commands, paths, and model names truncate or wrap without breaking ANSI styling.

#### Keyboard-first interaction

- Arrows or `j/k`: navigate
- `Enter`: open details
- `Tab`: move between sections
- `Esc`: return or close consistently
- `s`: steer
- `f`: follow up
- `o`: open tmux
- `c`: check now
- `p`: pause or resume
- `r`: restart or replace
- `x`: abort
- `d`: close or dismiss

Steering uses pi's `Editor` or `Input`. Hints respect configured keybindings where applicable. No important action depends on hover or color.

#### Accessible state presentation

State uses icon, text, and color together:

```text
⠋ Running
◌ Queued
Ⅱ Paused
! Blocked
↻ Retrying
✓ Completed
✗ Failed
? Orphaned
```

Focused inputs implement `Focusable` and emit `CURSOR_MARKER`. Animation can be disabled.

### Compact widget

```text
Agents  2 running · 1 queued · 3 idle
⠋ worker-2  $ npm test                    01:42
◌ scout-4   queued: memory reservation
✓ review-1  3 findings                    00:31
Parent review in 03:42 · watchdog 12s ago
```

### Dashboard

```text
┌ Agents ─────────────────────────────────────────────┐
│ 3 running · 2 idle · 1 queued       Review 03:42   │
│ Watchdog healthy · checked 12s ago                  │
├──────────────────┬──────────────────────────────────┤
│ Agents           │ worker-2                         │
│                  │ Running for 01:42                │
│ › worker-2   ⠋   │                                  │
│   scout-1    ✓   │ Current: $ npm test              │
│   reviewer-3 ◌   │ Queue: 2 messages                │
│                  │ Worktree: ../.worktrees/worker-2 │
├──────────────────┴──────────────────────────────────┤
│ enter details · s steer · o tmux · c check · esc   │
└─────────────────────────────────────────────────────┘
```

At narrow widths, list and details become separate tabs instead of compressed columns.

Dashboard views include overview, selected-agent details, steering queue, recent activity, worktree and Git status, usage and resources, watchdog diagnostics, scheduler queue, and settings.

### Steering UX

Delivery options are immediate steer, follow up after current work, prompt when idle, or replace a queued instruction. Submitted messages appear in the queue immediately with acknowledgement.

### Timer UX

The widget and dashboard show:

- Next watchdog scan
- Last successful heartbeat
- Next parent supervisory review
- Time since meaningful progress
- Current stuck threshold

Overdue timers use explicit text such as `Parent review overdue by 00:18`, not color alone.

## TUI Developer Experience

### Component structure

```text
ui/
├── agent-dashboard.ts
├── agent-list.ts
├── agent-details.ts
├── steering-editor.ts
├── progress-widget.ts
├── supervision-timer.ts
├── status-badge.ts
├── view-model.ts
├── render-scheduler.ts
└── tui-test-harness.ts
```

- Domain state remains independent from TUI components.
- Components consume immutable typed view models.
- Components do not directly run tmux, Git, or RPC operations.
- Actions use typed callbacks.
- One render scheduler coalesces updates.
- Timers, subscriptions, and watchers expose deterministic disposal.
- Theme values come from the injected pi theme.
- No dependency on private TUI internals.

Reusable patterns cover status badges, bordered panels, action hints, durations, countdowns, path and command truncation, empty/loading/error states, and confirmation flows.

### TUI test harness

A standalone fixture harness provides synthetic states for no agents, one running agent, many agents, long values, mixed outcomes, queued steering, paused/orphaned agents, overdue review, and missing tmux.

Fixtures render in light and dark themes at widths including 40, 60, 80, 120, and 180 columns.

### TUI acceptance criteria

- [ ] Widget conveys status and next parent review without opening the dashboard.
- [ ] Dashboard remains usable at 40 columns.
- [ ] No rendered line exceeds its supplied width.
- [ ] Selection remains stable during streaming updates.
- [ ] All actions are keyboard accessible.
- [ ] IME cursor positioning works in steering inputs.
- [ ] Light and dark themes use injected theme tokens.
- [ ] Every state has icon and text, not color alone.
- [ ] Rapid child events do not cause visible flicker.
- [ ] Timers update and clean up without leaking intervals.
- [ ] Overlay focus returns correctly after dialogs or tmux attachment.
- [ ] Returning from tmux restores the pi TUI.
- [ ] Empty, loading, paused, blocked, failed, and orphaned states are explicit.
- [ ] Non-TUI modes return structured results without unsupported UI calls.
- [ ] Component fixtures and width assertions pass automatically.

## Interface Contracts

### Parent-facing actions

- `spawn`
- `list`
- `status`
- `prompt`
- `steer`
- `follow_up`
- `pause`
- `resume`
- `abort`
- `restart`
- `replace`
- `diff`
- `validate`
- `merge`
- `close`

Every mutating request carries a command ID and returns structured state.

### Commands

- `/agents`
- `/agents new`
- `/agents attach <agent>`
- `/agents steer <agent> <message>`
- `/agents check`
- `/agents doctor`
- `/agents setup`
- `/agents clean`

## Installation and Setup

The package bundles the extension, runner, watchdog, UI, and agent definitions.

`/agents doctor` verifies tmux, Git, Node, the state directory, tmux connectivity, extended keys, process/resource probes, worktree support, and stale sessions.

`/agents setup` may offer confirmed installation commands through Homebrew or a detected Linux package manager. It never invokes `sudo`, modifies shell files, or edits `~/.tmux.conf` without explicit approval.

## Error Handling

- Missing tmux window → mark orphaned and offer recovery
- Runner crash → checkpoint and restart
- RPC crash → runner restarts child and reopens its session
- Invalid event-log tail → recover to the last valid JSONL record
- Full disk → stop admission and alert the parent
- Merge conflict → parent resolves or delegates
- Dirty worktree during cleanup → retain and notify
- Rate limiting → mark retrying and reduce provider admission pressure
- Parent restart → rescan state and tmux before accepting work

## Security

- Confirm trusted project-local agent definitions.
- Avoid shell interpolation and use argv-based process execution.
- Sanitize tmux identifiers.
- Store files with restrictive permissions.
- Do not expose secrets from environment or provider payloads.
- Cap model-visible output while retaining local transcripts.
- Disable recursive child orchestration unless explicitly granted.
- Record autonomous lifecycle and merge actions in the parent session.

## Testing Strategy

- **Unit:** state machine, command replay, parsing, scheduler, stuck detection, resource scoring, sanitization
- **Integration:** tmux creation, RPC steering, persistence, restart recovery, pause/resume, worktrees
- **TUI:** narrow/wide widths, themes, keyboard navigation, focus, truncation, timers, every state
- **End-to-end:** persistent agents, concurrent worktrees, parent restart, replacement, autonomous merge
- **Failure injection:** kill runner, kill RPC child, remove tmux window, partial JSONL, disk threshold
- **Manual:** attach/detach inside and outside tmux with extended keys

## Implementation Waves

### Wave 1 — Contracts, foundations, and TUI design system

Proceed in parallel:

1. State, event, and control protocol
2. Agent discovery and configuration
3. tmux adapter
4. Resource probe and scheduler model
5. Worktree manager
6. Typed dashboard view model
7. TUI fixture and rendering harness
8. Responsive component prototypes

### Wave 2 — Persistent runner

Blocked by the protocol contract. Implements RPC lifecycle, readable transcript, heartbeat, commands, and recovery.

### Wave 3 — Parent orchestration

Blocked by protocol and runner. Implements tools, scheduler, watchdog, persistence, and supervisory timers.

### Wave 4 — Integrated TUI

Blocked by stable orchestration state. Connects tested components to live state, actions, countdowns, attach flow, and notifications.

### Wave 5 — Autonomous Git workflow

Blocked by orchestration and worktrees. Adds validation, review/fix loops, local merge, and cleanup.

### Wave 6 — Hardening and packaging

End-to-end tests, failure injection, setup/doctor, documentation, package manifest, and compatibility validation.

## Risks

- Pausing during provider requests can trigger timeouts; use only under critical pressure.
- Persistent transcripts may contain sensitive repository content.
- Parent reviews consume tokens; reports and cadence must remain compact and configurable.
- Autonomous merges can integrate incorrect changes; validation and audit entries are required.
- tmux behavior varies by version and nested-session context.
