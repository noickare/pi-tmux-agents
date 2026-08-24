# Changelog

## 0.3.7 — 2026-08-24

### Added

- Add a host-version consistency check, grouped Pi dependency updates, and a scheduled latest-Pi compatibility job before releases are advanced
- Document staged Pi and extension updates, explicit tag movement, validation, and rollback

### Changed

- Require Pi 0.84.3 and develop against exact, synchronized Pi 0.84.3 host packages while keeping runtime core packages peer-provided

## 0.3.6 — 2026-08-23

### Changed

- Require, test, and develop against Pi 0.84.2 while keeping Pi core packages peer-provided as required for extension packages and reporting version drift through `/agents-doctor`
- Inherit the parent model and thinking level for ad-hoc children unless a role or spawn request explicitly overrides the model
- Bound model-visible agent list, status, result, finding, and review-packet text while retaining full data in durable results and tool details

### Fixed

- Recreate missing tmux runner windows from durable jobs—even before their first snapshot—when a parent session resumes after a machine reboot
- Replay terminal review decisions before reconnecting child RPC, lazily reconnect revisions, keep settled results reviewable when RPC exits, and dismiss parked results through close-and-clean
- Make stale runner-lock takeover atomic and boot-aware so reboot PID reuse or concurrent recovery cannot create two active state writers
- Preserve Pi 0.84 cumulative streaming usage for interrupted attempts without double-counting finalized assistant usage
- Stop processing command batches after terminal review decisions, reject tmux attachment outside TUI mode, and release runner locks reliably during signal shutdown
- Exclude parked and attention-only agents from periodic execution-review wakeups, and serialize parent wake dispatch through prompt startup

## 0.3.5 — 2026-08-19

### Fixed

- Cancel queued agents directly before launch instead of writing abort or close commands that no runner exists to consume
- Claim admitted queue entries before launch so cancellation cannot leave a stale entry that starts later
- Clarify that an empty agent list is scoped to the current parent Pi session

## 0.3.4 — 2026-08-03

### Fixed

- Hide closed and superseded agents from the progress widget, and remove terminal replacement lineages from persisted state and the registry after explicit cleanup succeeds

## 0.3.3 — 2026-08-03

### Fixed

- Force-restart an unresponsive child RPC session when graceful abort exceeds the RPC request timeout, preserve the partial attempt as an interrupted review result, and keep the child available for revision
- Test against Pi 0.83.x, matching the supported runtime used by the extension
- Make healthy watchdog status authoritative in parent guidance so short periods without visible progress do not trigger premature steering, abort, restart, or replacement

## 0.3.2 — 2026-07-26

### Fixed

- Do not reinterpret a settled attempt's historical tool failures or provider retries as a live execution-stall condition
- Never auto-remediate an `awaiting_review` child with execution commands such as `steer`, `restart`, or replacement
- Distinguish results awaiting parent review from blocked, failed, or orphaned agents in the progress widget
- Show parked results as delivered to the parent instead of displaying the unrelated periodic supervision countdown

## 0.3.1 — 2026-07-26

### Fixed

- Qualify bare child model IDs with the active parent provider so ambiguous IDs do not resolve to an unauthenticated provider
- Surface rejected initial prompts as failed agents with the underlying RPC error instead of leaving zero-usage children apparently idle
- Serialize concurrent first-child tmux launches and recover safely when another creator wins the shared-session race
- Remove incomplete state directories when tmux launch fails

## 0.3.0 — 2026-07-26

### Added

- Persist versioned assignment-attempt results with final assistant output, usage, workspace metadata, and durable result paths
- Deliver settled child results directly to the parent agent for mandatory review
- Add explicit `result`, `revise`, `accept`, `take_over`, `escalate`, and `dismiss` orchestration actions
- Add the non-terminal `awaiting_review` lifecycle state and durable parent review decisions

### Changed

- Start protocol v2 as a clean state-model break; incompatible v1 snapshots are ignored rather than migrated
- Keep settled child sessions parked for parent review instead of returning them to ambiguous idle state
- Exclude review-parked children from progress-stall supervision and periodic execution reviews

### Fixed

- Coalesce parent supervision wakeups until the parent is idle, drop stale terminal-agent findings, and suppress unchanged watchdog alerts
- Keep manual watchdog checks from recursively scheduling another parent review turn
- Reject failed Pi RPC commands instead of acknowledging them as successful and leaving assignments idle

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
