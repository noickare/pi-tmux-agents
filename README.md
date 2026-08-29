# pi-tmux-agents

[![CI](https://github.com/noickare/pi-tmux-agents/actions/workflows/ci.yml/badge.svg)](https://github.com/noickare/pi-tmux-agents/actions/workflows/ci.yml)
[![GitHub release](https://img.shields.io/github/v/release/noickare/pi-tmux-agents)](https://github.com/noickare/pi-tmux-agents/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Run persistent, steerable [Pi](https://github.com/earendil-works/pi) coding agents in tmux. Each child gets an inspectable session, mutating work can be isolated in a Git worktree, and the parent Pi session supervises results and failures.

`pi-tmux-agents` is useful when one task can be split into independent research, implementation, test, or review tracks without losing visibility or control.

## Highlights

- **Persistent sessions:** child agents continue in tmux while the parent is busy or reloading.
- **Safe parallel edits:** mutating children work on dedicated `agent/*` branches in sibling Git worktrees.
- **Active supervision:** a watchdog checks heartbeats, progress, processes, tmux, resources, queues, and worktrees.
- **Resource-aware scheduling:** work is queued or paused when CPU, memory, disk, or provider pressure is too high.
- **Explicit review:** every settled result returns to the parent for acceptance, revision, takeover, dismissal, or escalation.
- **Terminal-first UI:** `/agents` opens a responsive dashboard; every child can also be inspected directly in tmux.

## Quick start

### 1. Check the prerequisites

| Requirement | Minimum |
| --- | --- |
| Operating system | macOS, Linux, or Windows through WSL |
| Node.js | 22.19 |
| Git | 2.20 |
| tmux | 3.2; 3.5+ recommended |
| Pi | 0.84.4 |

For reliable modified keys, add this to `~/.tmux.conf`:

```tmux
set -g extended-keys on
set -g extended-keys-format csi-u
```

`extended-keys-format csi-u` requires tmux 3.5+. On tmux 3.2–3.4, use only `set -g extended-keys on`. Restart the tmux server after changing the file.

### 2. Install a reviewed release

Pi packages run with your user permissions. Review the source before installing it.

```bash
pi install git:github.com/noickare/pi-tmux-agents@v0.3.8
```

The version tag is intentionally pinned. See [Updating](docs/UPDATING.md) before moving to another release.

### 3. Verify the installation

Start Pi inside a Git repository and run:

```text
/agents-doctor
```

The doctor checks required versions, tmux options, private state storage, resource probes, and Git worktree support. `/agents-setup` shows non-destructive setup guidance; it never runs `sudo`, installs packages, or edits configuration.

### 4. Delegate a first task

Ask the parent naturally:

```text
Create a read-only child to map this repository's test structure. Review its result and summarize the important parts.
```

For a mutating task:

```text
Create a worker to fix the failing tests in an isolated worktree. Validate its changes, review the result, and tell me what should be merged.
```

The parent uses the `tmux_agent` tool. You can monitor work with `/agents`; completed work is delivered back to the parent automatically.

## How it works

```text
Parent Pi session
├── tmux_agent tool and /agents dashboard
├── scheduler and watchdog
└── tmux session
    ├── read-only child → project directory
    └── mutating child  → ../.worktrees/<agent-id> on agent/<agent-id>
```

A child result does not merge itself. The parent reviews the result and workspace, records a decision, validates changes when appropriate, and decides whether to merge, take over, or discard the work.

Runtime state is local to the parent Pi session and stored under:

```text
~/.pi/agent/subagents/<parent-session-id>/
```

Transcripts and results can contain repository content or secrets printed by tools. Treat this directory as sensitive.

## Common commands

| Command | Purpose |
| --- | --- |
| `/agents` | Open the dashboard |
| `/agents new <task>` | Start an ad-hoc mutating child |
| `/agents check` | Run the watchdog now |
| `/agents attach <id>` | Open a child's tmux window |
| `/agents steer <id> <message>` | Correct active work immediately |
| `/agents follow-up <id> <message>` | Queue work until the child finishes its current work |
| `/agents diff <id>` | Inspect changes from the child's base commit |
| `/agents validate <id> <executable> [args...]` | Run a command in the child workspace |
| `/agents clean [--discard]` | Remove terminal children and eligible worktrees |
| `/agents-doctor` | Check dependencies and configuration |

See [Usage](docs/USAGE.md) for lifecycle decisions, all direct commands, dashboard keys, and custom agent definitions.

## Documentation

- [Documentation index](docs/README.md)
- [Usage and workflows](docs/USAGE.md)
- [Configuration reference](docs/CONFIGURATION.md)
- [Troubleshooting and cleanup](docs/TROUBLESHOOTING.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Updating and rollback](docs/UPDATING.md)
- [Changelog](CHANGELOG.md)

## Project status

The current release is v0.3.8. The project is usable for production-oriented local workflows, but it remains pre-1.0: release notes may announce intentional protocol or configuration breaks. Pin releases and read the [changelog](CHANGELOG.md) before updating.

## Security

Pi extensions execute with your system permissions. This project avoids shell interpolation, requires trust before using project-local definitions or configuration, disables recursive child extension discovery, and does not silently push Git remotes or modify system configuration.

Read the [security policy](SECURITY.md) before reporting a vulnerability. Do not include sensitive transcripts in public issues.

## Contributing and support

Bug reports, focused feature proposals, documentation fixes, and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md). For usage problems, check [Troubleshooting](docs/TROUBLESHOOTING.md), then search or open a [GitHub issue](https://github.com/noickare/pi-tmux-agents/issues).

## License

[MIT](LICENSE) © Ian Likono and pi-tmux-agents contributors.
