# Troubleshooting and cleanup

Start with the built-in doctor:

```text
/activity doctor
```

It checks tmux, Git, Pi, Node.js, state-directory permissions, tmux connectivity and key settings, system resource probes, real Git worktree creation, and stale managed sessions.

`/activity setup` displays suggested fixes without executing commands or changing files.

## Common problems

### Modified keys do not work in tmux

Add this to `~/.tmux.conf` when using tmux 3.5 or newer:

```tmux
set -g extended-keys on
set -g extended-keys-format csi-u
```

On tmux 3.2–3.4, omit `extended-keys-format csi-u`.

Restart tmux fully after the change:

```bash
tmux kill-server
tmux
```

`tmux kill-server` ends every tmux session on that server. Save or stop unrelated tmux work first.

### Links, images, or colors are misdetected behind tmux

Pi 0.84.4 can override terminal capability detection when a multiplexer or terminal proxy hides the outer terminal's support:

```bash
PI_HYPERLINKS=1 PI_IMAGE_PROTOCOL=kitty PI_TRUE_COLOR=1 pi
```

Use `0` or `none` to force a capability off, and `auto` to restore detection. The equivalent Pi settings are `terminal.hyperlinks`, `terminal.images`, and `terminal.trueColor`; settings take precedence over environment variables. Only force capabilities supported by the complete terminal path because unsupported escape sequences can corrupt rendering.

These overrides affect the parent Pi TUI. Child agents run in RPC mode and do not render terminal images or hyperlinks themselves.

### Activity shows no delegated work

Children are scoped to the current parent Pi session. Resume the parent session that created them, or inspect managed tmux sessions with:

```bash
tmux list-sessions
```

Managed sessions start with `pi-agents-`. Do not kill one until you have checked whether it corresponds to durable state or active work.

### A child remains queued

Run `/activity check` and open Activity's Events view. Common reasons are:

- memory reservation would be exceeded;
- disk space is below the configured minimum;
- CPU or active build/test pressure is high;
- the model provider is backing off or rate limited.

Queued requests are durable and will be retried by the scheduler. Prefer waiting or correcting the underlying pressure over lowering safeguards. See [Configuration](CONFIGURATION.md#resource-scheduling) if the defaults do not fit the machine.

### A child looks stuck

Run:

```text
/activity check
```

Treat the watchdog result as authoritative. Quiet output alone is not a stall before `progressStaleMs` expires. When a current finding exists, automatic remediation may diagnose, restart, and eventually replace the child. You can inspect live output with `/activity attach <id>`.

### Attach says TUI mode is required

Direct tmux attachment uses Pi's interactive terminal suspension and is available only in TUI mode. In print, JSON, or RPC mode, use agent status, result paths, logs, or a separate `tmux attach-session` command instead.

### A project agent role is unknown or untrusted

Check that:

- the file is under `~/.pi/agent/agents/*.md` or `.pi/agents/*.md`;
- its frontmatter has both `name` and `description`;
- the project is trusted in Pi;
- the spawn explicitly approves project context for project-local roles.

Project roles and prompts are never enabled solely because the file exists.

### Cleanup retains a worktree

Cleanup deliberately keeps dirty worktrees. Inspect the agent and its diff:

```text
/activity diff <id>
```

Then commit or integrate wanted changes, remove unwanted changes manually, or use `/activity clean --discard` only after confirming that permanent deletion is safe.

A merge also requires the child worktree to be clean. Validation and acceptance do not automatically commit, merge, or clean work.

### The machine rebooted or the tmux server disappeared

Resume the same parent Pi session. The extension uses durable `agent.json` jobs to recreate eligible missing runner windows, replay unacknowledged commands, and redeliver pending results.

If recovery fails, run `/activity doctor` and `/activity check`. Preserve the state directory and worktree while investigating; they are the recovery sources.

### The extension prevents Pi from starting

Start Pi without extensions:

```bash
pi -ne
```

Then restore the previous pinned release, fix invalid JSON in `~/.pi/agent/tmux-agents.json` or `.pi/tmux-agents.json`, or remove the package source. See [Updating](UPDATING.md#roll-back).

### WSL setup fails

Install and run Node.js, Git, tmux, Pi, `ps`, and `df` inside the same WSL distribution. Native Windows outside WSL is not supported.

## Logs and local state

Per-parent state lives under:

```text
~/.pi/agent/subagents/<parent-session-id>/
```

Useful child files include:

- `agent.json` for the durable runner job and recovery identity;
- `snapshot.json` for current status;
- `events.jsonl` and `commands.jsonl` for control history;
- `sessions/*.jsonl` for the child Pi sessions;
- `assignments/*/attempts/*/result.json` for complete durable results;
- `runner.lock` for the active state-writer identity.

Readable live output is kept in the child's tmux window rather than a separate transcript log. These files and tmux scrollback may contain source code, prompts, command output, paths, model responses, or secrets exposed by tools. Redact them before sharing. Public issues should normally include only:

- operating system and versions from `node --version`, `git --version`, `tmux -V`, and `pi --version`;
- the installed extension version from `pi list`;
- redacted `/activity doctor` and watchdog output;
- a minimal reproduction;
- whether the parent session was new, resumed, or recovered after reboot.

## Cleanup and uninstall

First settle or explicitly stop active work. Then clean terminal children:

```text
/activity clean
```

Inspect anything retained. Use `--discard` only for work you intend to delete permanently.

List the configured package source and remove that exact source:

```bash
pi list
pi remove <source-shown-by-pi-list>
```

Removing the package does not prove that every child worktree or durable result is safe to delete. Review sibling `.worktrees/` directories and `~/.pi/agent/subagents/` before manual removal.

The doctor may report stale tmux sessions. After confirming a reported session has no needed work, remove only that session:

```bash
tmux kill-session -t <session-name>
```

## Getting help

Search the [issue tracker](https://github.com/noickare/pi-tmux-agents/issues) for the exact error. If it is new, open an issue with the redacted diagnostic information above. Report vulnerabilities privately through the [security policy](../SECURITY.md).
