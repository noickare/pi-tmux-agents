# pi-tmux-agents

Persistent, steerable, tmux-backed subagents for [pi](https://github.com/earendil-works/pi-mono), with isolated Git worktrees, autonomous parent orchestration, resource-aware scheduling, watchdog supervision, and a responsive terminal UI.

> **Status:** Initial open-source release candidate. See the [approved PRD](docs/PRD.md).

## Features

- Persistent pi RPC sessions in readable tmux windows
- Repeated prompts, immediate steering, and queued follow-ups
- Dedicated Git worktrees and branches for mutating agents
- Resource-aware durable admission queue without a fixed agent limit
- Heartbeat, process, progress, tmux, and retry supervision
- Five-minute parent reviews and configurable idle expiry
- Automatic parent wakeups for completion and attention states
- Restart-safe command acknowledgement, replay, locks, and snapshots
- Responsive, keyboard-first pi dashboard and compact progress widget
- User and trusted project Markdown agent definitions
- Guided setup and diagnostics without silent system changes

## Requirements

- macOS, Linux, or WSL
- Node.js 22.19 or newer
- Git
- tmux 3.2 or newer; tmux 3.5+ recommended
- pi 0.81.1 or compatible

Recommended `~/.tmux.conf` for reliable modified keys:

```tmux
set -g extended-keys on
set -g extended-keys-format csi-u
```

Restart the tmux server after changing this configuration. On tmux 3.2–3.4, omit `extended-keys-format csi-u`.

## Installation

Install directly from GitHub:

```bash
pi install git:github.com/noickare/pi-tmux-agents
```

For development:

```bash
git clone https://github.com/noickare/pi-tmux-agents.git
cd pi-tmux-agents
npm install
pi -e ./src/extension/index.ts
```

Run `/agents-doctor` after installation. `/agents-setup` provides guidance but never invokes `sudo`, installs packages, or edits configuration itself.

## Usage

Ask the parent naturally:

```text
Create a scout to inspect authentication and a worker to fix the failing tests.
Steer the worker to focus on integration tests.
Check whether any children are stuck.
Validate and merge the worker's branch when ready.
```

The parent uses the `tmux_agent` tool. Direct commands are also available:

```text
/agents                         Open the dashboard
/agents new <task>              Start an ad-hoc mutating worker
/agents check                   Run the watchdog immediately
/agents doctor                  Verify dependencies and tmux configuration
/agents setup                   Show non-destructive setup guidance
/agents attach <id>             Open the agent's tmux window
/agents steer <id> <message>    Steer a running agent
/agents-doctor                  Alias for /agents doctor
/agents-setup                   Alias for /agents setup
```

Dashboard keys:

```text
↑↓ or j/k  navigate        s  steer        o  open tmux
c          check now       x  abort        Esc close
```

## Agent definitions

User agents live in `~/.pi/agent/agents/*.md`. Trusted project agents may live in `.pi/agents/*.md`.

```markdown
---
name: reviewer
description: Reviews code and reports actionable findings
tools: read, grep, find, ls, bash
model: anthropic/claude-sonnet-4-5
---

Review the requested change. Be specific and do not modify files.
```

Project agents are ignored unless the project is trusted and project approval is explicitly enabled for the child.

## Configuration

Global configuration: `~/.pi/agent/tmux-agents.json`

Trusted project override: `.pi/tmux-agents.json`

```json
{
  "monitorIntervalMs": 1000,
  "watchdogIntervalMs": 30000,
  "heartbeatStaleMs": 30000,
  "progressStaleMs": 600000,
  "parentReviewIntervalMs": 300000,
  "schedulerIntervalMs": 5000,
  "idleTimeoutMs": 14400000,
  "parentReservedCpu": 1,
  "parentReservedMemoryBytes": 1073741824
}
```

## State and recovery

Runtime state is stored under:

```text
~/.pi/agent/subagents/<parent-session-id>/<agent-id>/
```

Each child has an isolated pi session, command/event logs, an atomic snapshot, transcript, and runner lock. Tmux children continue when the parent reloads or restarts; the extension reconnects by scanning these snapshots.

## Security

Pi extensions run with your system permissions. Review extension and agent-definition source before use. This project avoids shell interpolation, gates project prompts on trust, disables recursive child extensions, uses private state files, and does not silently modify system configuration or remote Git state. See [SECURITY.md](SECURITY.md).

## Development

```bash
npm ci
npm run validate
npm run tui:fixtures
npm run smoke:runner
npm run smoke:extension
npm run pack:check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution requirements.

## License

[MIT](LICENSE)
