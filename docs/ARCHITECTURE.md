# Architecture

This document describes the implemented architecture of `pi-tmux-agents` v0.4.0. It replaces the historical implementation PRD as the source of truth for current component boundaries and runtime behavior.

## System overview

```text
Parent Pi process
└── pi-tmux-agents extension
    ├── /activity main-agent event tracker
    ├── optional tmux_agent delegation
    ├── AgentOrchestrator
    ├── admission queue and resource scheduler
    ├── snapshot monitor and watchdog
    ├── worktree and tmux services
    └── Activity overlay and compact widget
             │ durable files + tmux
             ▼
    tmux session: pi-agents-<parent-session-id>
    ├── child-1 → persistent runner → pi --mode rpc
    └── child-2 → persistent runner → pi --mode rpc
```

The parent extension and each child runner are separate processes. They coordinate through append-only command/event logs and atomic snapshots rather than terminal scraping. Tmux provides persistent, inspectable terminal sessions; it is not the source of truth for orchestration state.

## Components

### Parent extension

`src/extension/index.ts` is the package entry point. It:

- registers the optional `tmux_agent` tool and `/activity` commands;
- translates public Pi lifecycle, message, tool, prompt, and compaction events into a bounded main-agent timeline;
- creates session-scoped services when the parent Pi session starts;
- restores durable child state and missing runner windows;
- delivers completed results and current attention states to the parent;
- runs scheduler, watchdog, and parent-review timers;
- installs the Activity overlay and below-editor widget in TUI mode;
- disposes subscriptions and timers when the parent session shuts down.

### Orchestrator and services

`src/services/orchestrator.ts` owns child lifecycle decisions. Supporting services keep external concerns separate:

- `admission-queue.ts` persists queued spawn requests.
- `resource-probe.ts` measures CPU, memory, disk, active builds, and provider pressure.
- `scheduler.ts` makes deterministic admission and pressure decisions.
- `tmux.ts` manages tmux sessions and windows with argv-based commands.
- `runner-launcher.ts` writes child jobs and launches or recovers runners.
- `worktrees.ts` creates, validates, merges, and removes Git worktrees and branches.
- `snapshot-monitor.ts` reads durable child snapshots into the in-memory registry.
- `watchdog.ts` checks heartbeats, progress, processes, tmux, queues, resources, UI requests, and worktrees.
- `parent-wake-coordinator.ts` coalesces result and supervision messages until the parent is idle and outside blocking extension UI prompts.

### Persistent child runner

`src/runner/persistent-runner.ts` runs inside each child tmux window. It:

- starts Pi in RPC mode with child extension discovery disabled;
- sends the assignment, steering, follow-ups, and control commands over RPC;
- clears queued steering and follow-ups before abort or graceful RPC shutdown;
- translates structured RPC events into readable terminal output and durable state;
- retains bounded provider reasoning summaries, response blocks, and tool events in occurrence order for Activity;
- emits heartbeats independently of model output;
- persists a result before entering `awaiting_review`;
- acknowledges commands so replay is idempotent;
- keeps reviewable results available even if the RPC child has exited.

The runner lock ensures only one process writes a child's state. Lock takeover checks process and boot identity so a reboot or PID reuse does not create concurrent writers.

### UI

`src/ui/` consumes immutable view models from the registry. It does not execute Git, tmux, or RPC commands directly; typed callbacks return actions to the extension.

The compact widget always gives an at-a-glance main-agent state, including when there are no children. The Activity overlay has Overview, Main, Delegated, and Events views. Main reasoning summaries use Pi's native subdued thinking treatment and are interleaved with observable tools and responses. The extension never claims hidden raw chain-of-thought. Direct tmux attachment remains available for complete child-session inspection.

Pi's public component contract exposes keyboard input through `handleInput` but no mouse hit-testing or click callbacks. Activity therefore presents explicit keyboard navigation rather than rendering controls that appear clickable but cannot work.

## Durable state

State is scoped by parent Pi session:

```text
~/.pi/agent/subagents/<parent-session-id>/
├── queue.json
└── <agent-id>/
    ├── agent.json
    ├── commands.jsonl
    ├── events.jsonl
    ├── snapshot.json
    ├── runner.lock
    ├── sessions/
    │   └── <child-session>.jsonl
    ├── assignments/
    │   └── <assignment-id>/attempts/<attempt-id>/result.json
    └── system-prompt.md (when a role supplies one)
```

Key ownership rules:

- The parent appends commands.
- The runner appends events and updates its snapshot.
- JSONL records have stable IDs for acknowledgement and replay.
- Snapshots and results use atomic writes.
- Runtime directories and control files use restrictive permissions.
- Model-visible summaries are bounded; full local results remain available at their recorded paths.

Protocol v3 state is intentionally not compatible with earlier protocols. Unsupported snapshots are ignored rather than migrated.

## Lifecycle

A typical child moves through:

```text
queued (when admission is delayed) → starting → idle → running
                                                   ├── retrying
                                                   ├── compacting
                                                   ├── paused
                                                   └── aborting
                                                        ↓
                                               awaiting_review
                                                ├── revise → running
                                                ├── escalate → awaiting_review
                                                ├── accept → closed
                                                ├── take_over → closed
                                                └── dismiss → closed
```

Failure and replacement states include `failed`, `orphaned`, and `replaced`.

A settled attempt is persisted before `awaiting_review`. While review is pending, ordinary prompt, steer, follow-up, and close requests are rejected. This prevents a new task from hiding an unreviewed result. Revision creates another attempt in the same assignment and workspace.

Review decisions close the child process where appropriate but do not implicitly merge or discard its Git branch. Integration and cleanup remain separate parent decisions.

## Message routing

- An idle child receives a new `prompt` assignment.
- Active work receives immediate `steer` or queued `follow_up` messages.
- Steering or follow-up sent to an idle child is normalized to a prompt.
- Control requests remain durable while a child is paused, but new messages should be sent after resume because the RPC process group is suspended.
- Abort clears queued steering and follow-ups before cancelling active work; an unconfirmed clear forces an RPC restart.
- An awaiting-review child accepts only review actions; corrections use `revise`.
- Duplicate command IDs are acknowledged once and ignored on replay.
- Interrupted or failed attempts still produce reviewable results when possible.

## Git isolation

Mutating children receive:

- a sibling worktree at `<repository-parent>/.worktrees/<agent-id>`;
- a branch named `agent/<agent-id>`;
- the parent's current commit as the base commit.

Read-only children share the parent working directory. The parent can inspect a diff from the base, run validation in the child workspace, merge the branch locally, or take over. Remote pushes and pull requests are outside the automatic workflow.

Cleanup refuses to remove dirty worktrees unless discard is explicit. Replacement keeps the existing worktree and branch and sends the new child the original task, previous status, and replacement reason.

## Scheduling and supervision

There is no fixed concurrency setting. Admission considers:

- logical CPU count, system load, and active task weights;
- available memory after reserving parent memory;
- available disk space;
- detected build and test processes;
- task priority and weight;
- provider retry or backoff state.

Elevated or critical pressure queues new work. Critical pressure can automatically pause non-interactive children. Auto-paused work resumes only after pressure remains normal for the configured recovery interval.

The lightweight watchdog runs without invoking a model. For an actionable current finding, automatic remediation proceeds in stages:

1. send a diagnostic steer when the RPC child is responsive;
2. wait for the remediation grace period;
3. restart the RPC session if progress remains stale;
4. replace the child with a worktree/context handoff if restart does not recover it.

Missing processes or tmux windows can move directly toward replacement. Settled results are excluded from execution-stall remediation.

The parent also receives periodic consolidated execution reviews. Result delivery is event-driven and separate so completed work is reviewed promptly without repeated supervision messages.

## Recovery

Tmux children continue when the parent reloads or exits. When the same parent Pi session resumes, the extension scans durable state, reconnects live snapshots, recreates missing runner windows from `agent.json`, replays unacknowledged commands, and redelivers results whose review is still pending.

A machine reboot removes the tmux server but not durable state. Recovery recreates eligible windows; creating, queued, failed, closed, and replaced children are not launched as active runners.

## Security boundaries

The extension is an orchestration and isolation tool, not a sandbox.

Implemented boundaries include:

- project-local definitions and configuration require Pi project trust;
- project prompts require explicit child approval;
- child extension discovery is disabled to prevent recursive orchestration;
- command execution uses executable/argv pairs instead of shell interpolation;
- tmux and agent identifiers are validated before use;
- mutating children edit separate physical worktrees;
- state files are private by default;
- no automatic `sudo`, dependency installation, remote push, force reset, or remote deletion.

The parent model, child models, and allowed tools still run with the user's permissions. A malicious repository, prompt, dependency, or tool output can influence model behavior. Human and parent review remain part of the trust model.

## Intentional boundaries

The project does not currently provide:

- distributed execution across machines;
- native Windows support outside WSL;
- a web dashboard;
- OS-level sandboxing;
- automatic remote pushes or pull-request creation;
- migration between incompatible durable-state protocol generations.

## Source map

| Area | Primary files |
| --- | --- |
| Protocol and state | `src/core/protocol.ts`, `state-machine.ts`, `state-store.ts` |
| Agent definitions and config | `src/core/agents.ts`, `config.ts` |
| Parent orchestration | `src/extension/index.ts`, `src/services/orchestrator.ts` |
| Runner and RPC | `src/runner/persistent-runner.ts`, `pi-rpc-process.ts`, `pi-invocation.ts` |
| Scheduling and recovery | `src/services/scheduler.ts`, `watchdog.ts`, `runner-launcher.ts` |
| Git and tmux | `src/services/worktrees.ts`, `tmux.ts` |
| TUI | `src/ui/activity-dashboard.ts`, `activity-widget.ts`, `view-model.ts` |
| Main activity capture | `src/core/main-activity.ts` |
| Validation | `test/`, `scripts/`, `.github/workflows/ci.yml` |
