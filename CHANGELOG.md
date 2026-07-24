# Changelog

## 0.2.3 — 2026-07-24

### Fixed

- Serialize admission queue mutations so parallel agent spawns cannot lose queued work or corrupt `queue.json`
- Use collision-proof temporary filenames and clean up failed atomic writes

## 0.2.2 — 2026-07-24

### Fixed

- Use a full-width, zero-margin focused dashboard below 60 columns so underlying terminal text cannot remain visible beside the overlay

## 0.2.1 — 2026-07-24

### Fixed

- Use macOS memory-pressure availability instead of immediately free pages, preventing healthy systems from being permanently classified as critical
- Preserve the first word in inline `/agents new <task>` commands
- Route steering and follow-ups sent to idle agents as new prompts
- Make dashboard overlays opaque, theme-aware, and responsive to live terminal resizing
- Deduplicate concurrent close/cleanup operations and make Git cleanup idempotent
- Surface dashboard action failures instead of allowing unhandled rejections to terminate pi
- Clear stale tool activity when an agent is closed or replaced
- Follow replacement lineage during cleanup without retaining superseded worktrees

## 0.2.0 — 2026-07-24

### Added

- First-class replacement with transcript context and existing worktree/branch handoff
- Parent actions for diff, argv-safe validation, reprioritization, and cleanup
- Dashboard views for details, steering queue, activity, resources, diagnostics, and settings
- Dashboard follow-up, pause/resume, restart/replace, abort, attach, and close actions
- Priority classes, build/test process detection, provider-backoff admission, and critical-pressure auto-pause/resume
- Watchdog checks for worktrees, resources, queue health, repeated retries/tool failures, extension UI requests, and state consistency
- Staged watchdog remediation through diagnostic steering, RPC restart, and replacement
- Doctor probes for versions, tmux lifecycle, resources, real temporary Git worktrees, permissions, and stale sessions

## 0.1.0 — 2026-07-24

Initial public release.

### Added

- Persistent tmux-backed pi RPC agents
- Durable commands, events, snapshots, heartbeats, and replay
- Repeated prompts, steering, follow-ups, abort, pause/resume, restart, and close
- Isolated Git worktrees and parent-controlled local merges
- Resource-aware durable admission queue
- Snapshot monitor, watchdog, parent review timer, and idle expiry
- Responsive dashboard, progress widget, and live tmux attachment
- User and trusted project agent definitions
- Guided `/agents doctor` and `/agents setup` workflows
- Unit, integration, live runner, extension, TUI, package, and CI validation
