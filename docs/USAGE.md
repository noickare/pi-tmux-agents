# Usage

`pi-tmux-agents` is controlled primarily through natural-language requests to the parent Pi session. The parent calls the `tmux_agent` tool, while `/agents` commands provide direct operator controls.

## Core concepts

- **Parent:** the Pi session where the extension is loaded. It delegates work and owns the final review decision.
- **Child:** a persistent Pi RPC session running in a tmux window.
- **Read-only child:** works in the parent's current directory without a dedicated branch or worktree.
- **Mutating child:** works on an `agent/<agent-id>` branch in a sibling `.worktrees/<agent-id>` directory.
- **Assignment attempt:** one run of a task. Requesting a revision keeps the assignment and workspace but creates another attempt.
- **Awaiting review:** the child has settled and produced a durable result; ordinary prompts cannot bypass the parent's review.

Agent lists and runtime state are scoped to the current parent Pi session. An empty `/agents` dashboard does not mean another parent session has no children.

## Typical workflows

### Read-only research

Ask for a read-only child when no files need to change:

```text
Create a read-only child to inspect the authentication flow. Review its result and give me a concise risk summary.
```

Read-only children are lighter-weight and share the parent working directory. They should not be used for tasks that may edit files.

### Isolated implementation

A mutating child is the default:

```text
Create a worker to fix issue #42 in an isolated worktree. Run the relevant tests, review the returned result and diff, and recommend whether to merge it.
```

The parent can inspect the diff, run an argv-safe validation command in the child workspace, request a revision, merge the child branch locally, or take over the work.

### Parallel work

Independent tasks can run concurrently:

```text
Create one read-only child to find the root cause, one worker to implement the fix, and another read-only child to identify missing tests. Keep the work independent and review every result.
```

There is no fixed child limit. The scheduler admits work according to CPU, memory, disk, active builds, task weight, priority, and provider backoff. A request may enter `queued` until resources recover.

### Steering and follow-ups

Use steering for an immediate correction to active work:

```text
Steer the worker to preserve the public API and focus on the integration test failure.
```

Use a follow-up for work that should wait until the child finishes all current work:

```text
After the current work, ask the worker to run the focused regression test and summarize the output.
```

If the child is idle, steering and follow-up requests become a new prompt. If it is awaiting review, use a revision instead.

Aborting a running child first discards its queued steering and follow-up messages, then cancels the current operation. If queue clearing cannot be confirmed, the runner force-restarts the child RPC process so stale queued work cannot resume.

## Review decisions

Every settled child produces a result and moves to `awaiting_review`. The parent must inspect the result and authoritative workspace before recording one of these decisions:

| Decision | Meaning |
| --- | --- |
| `revise` | Send corrections to the same child and workspace as a new attempt |
| `accept` | Record that the result is accepted and close the child session |
| `take_over` | Close the child so the parent can continue the work itself |
| `dismiss` | Close the child without accepting its result |
| `escalate` | Keep the result awaiting review and ask the human for a genuine decision |

Acceptance does **not** merge or clean the branch. The parent still decides how changes enter the final deliverable. Dirty worktrees are retained unless discard is explicitly requested.

## Direct commands

| Command | Description |
| --- | --- |
| `/agents` | Open the dashboard |
| `/agents new <task>` | Start an ad-hoc mutating child |
| `/agents check` | Run the watchdog immediately |
| `/agents doctor` | Check prerequisites and configuration |
| `/agents setup` | Show non-destructive setup guidance |
| `/agents attach <id>` | Attach or switch to the child's tmux window; TUI mode only |
| `/agents steer <id> [message]` | Steer active work; opens an input when the message is omitted |
| `/agents follow-up <id> [message]` | Queue work until the child finishes its current work; opens an editor when omitted |
| `/agents abort <id>` | Clear queued messages and abort the child's current operation |
| `/agents replace <id> [reason]` | Replace a child while preserving its worktree and context handoff |
| `/agents diff <id>` | Show the worktree diff from the base commit |
| `/agents validate <id> <executable> [args...]` | Run a validation command without shell interpolation |
| `/agents clean [--discard]` | Clean terminal children; retain dirty work unless discard is explicit |
| `/agents-doctor` | Alias for `/agents doctor` |
| `/agents-setup` | Alias for `/agents setup` |

Agent IDs may be abbreviated when the prefix is unique. An exact agent name is also accepted when it identifies only one child.

`/agents clean --discard` can permanently remove uncommitted work. Inspect the affected worktrees first.

## Dashboard keys

| Key | Action |
| --- | --- |
| `↑`/`↓` or `j`/`k` | Select a child |
| `Enter` | Open details |
| `Tab` | Cycle overview, details, queue, activity, resources, diagnostics, and settings |
| `s` | Steer |
| `f` | Queue a follow-up |
| `p` | Pause or resume |
| `r` | Restart the RPC session or replace the child |
| `o` | Open the tmux window |
| `c` | Run the watchdog |
| `x` | Clear queued messages and abort current work |
| `d` | Close and clean |
| `Esc` | Return to overview or close the dashboard |

At narrow terminal widths, views are shown one at a time instead of side by side.

## Custom agent definitions

Reusable roles can be defined as Markdown files:

- User definitions: `~/.pi/agent/agents/*.md`
- Project definitions: `.pi/agents/*.md`

```markdown
---
name: reviewer
description: Reviews code and reports actionable findings
tools: read, grep, find, ls, bash
model: anthropic/claude-sonnet-4-5
---

Review the requested change. Be specific and do not modify files.
```

`name` and `description` are required. `tools` is a comma-separated list; `model` is optional. The Markdown body becomes the role's system prompt.

Project definitions are considered only when the project is trusted and project approval is explicitly enabled for the child. A project definition with the same name as a user definition takes precedence when project agents are approved.

Ad-hoc children inherit the active parent provider, model, and thinking level. A role or spawn-level model overrides that inheritance. Use Pi's `provider/model:thinking` shorthand when the override should also pin a thinking level.

## Advanced tool actions

The parent normally chooses these actions without user intervention. They are grouped here to clarify the public orchestration surface.

| Category | Actions |
| --- | --- |
| Inspect | `list`, `status`, `result`, `diff`, `check` |
| Delegate or message | `spawn`, `prompt`, `steer`, `follow_up`, `revise` |
| Review | `accept`, `take_over`, `escalate`, `dismiss` |
| Control | `pause`, `resume`, `abort`, `restart`, `replace`, `set_priority`, `close`, `clean` |
| Git and validation | `validate`, `merge` |

Priorities are `interactive`, `merge-critical`, `normal`, and `speculative`. Task weights are `light`, `normal`, and `heavy`. Read-only work defaults to `light`; mutating work defaults to `heavy`.

## Cleanup

After accepted work has been merged or otherwise handled, ask the parent to clean the child or run:

```text
/agents clean
```

Clean terminal worktrees and branches are removed. Dirty worktrees are retained with a reason so work is not lost. See [Troubleshooting and cleanup](TROUBLESHOOTING.md#cleanup-and-uninstall) for recovery and uninstall guidance.
