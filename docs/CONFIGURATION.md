# Configuration

All configuration is optional. `pi-tmux-agents` starts with safe defaults and accepts partial JSON overrides.

## Configuration files

Configuration is loaded in this order:

1. built-in defaults;
2. user configuration at `~/.pi/agent/tmux-agents.json`;
3. project configuration at `<current-directory>/.pi/tmux-agents.json`, only when the project is trusted.

Later values override earlier values. Project configuration is read from the current Pi working directory; unlike project agent discovery, it is not searched from parent directories.

Restart Pi or run `/reload` after editing configuration. Run `/activity doctor` to verify the surrounding environment.

## Example

Only include values you want to override:

```json
{
  "progressStaleMs": 900000,
  "parentReviewIntervalMs": 600000,
  "animationEnabled": false
}
```

All durations are milliseconds and all memory or disk values are bytes.

## Reference

### Monitoring and lifecycle

| Setting | Default | Purpose |
| --- | ---: | --- |
| `monitorIntervalMs` | `1000` (1 s) | Poll durable child snapshots for UI and orchestration updates |
| `watchdogIntervalMs` | `30000` (30 s) | Run automatic watchdog scans |
| `heartbeatStaleMs` | `30000` (30 s) | Report a child heartbeat as stale after this interval |
| `progressStaleMs` | `600000` (10 min) | Report no meaningful progress after this interval |
| `parentReviewIntervalMs` | `300000` (5 min) | Wake the parent for periodic review while execution is active |
| `schedulerIntervalMs` | `5000` (5 s) | Recheck resources, rebalance, and drain queued work |
| `idleTimeoutMs` | `14400000` (4 h) | Close launched children that remain idle this long |
| `queueStaleMs` | `1800000` (30 min) | Report an admission-queue entry as stale |
| `uiRequestStaleMs` | `60000` (1 min) | Report an unanswered child extension UI request as stale |

Settled children in `awaiting_review` are excluded from execution-stall remediation and periodic execution reviews. Their results are delivered separately for explicit parent review.

### Resource scheduling

| Setting | Default | Purpose |
| --- | ---: | --- |
| `parentReservedCpu` | `1` | Reserve this many logical CPUs for the parent; may be `0` |
| `parentReservedMemoryBytes` | `1073741824` (1 GiB) | Reserve memory for the parent before child admission |
| `minimumFreeMemoryBytes` | `2147483648` (2 GiB) | Queue new work when usable memory is at or below this level |
| `criticalFreeMemoryBytes` | `536870912` (512 MiB) | Treat usable memory at or below this level as critical pressure |
| `minimumFreeDiskBytes` | `5368709120` (5 GiB) | Reject admission when available disk is at or below this level |
| `maximumLoadPerAvailableCpu` | `1.25` | Maximum normal load or active-work score per usable CPU |
| `resourceRecoveryStableMs` | `30000` (30 s) | Require normal pressure for this long before auto-resuming work |

Usable memory is available memory minus `parentReservedMemoryBytes`. Usable CPU is the logical CPU count minus `parentReservedCpu`, with a minimum of one. The scheduler also accounts for task weight, detected build/test processes, and provider backoff.

### Automatic behavior and UI

| Setting | Default | Purpose |
| --- | ---: | --- |
| `autoPauseOnCritical` | `true` | Pause non-interactive active children during critical resource pressure and resume them after stable recovery |
| `autoRemediateStuck` | `true` | Diagnose stale work, then restart or replace it when findings persist |
| `remediationGraceMs` | `120000` (2 min) | Wait between diagnostic steering, restart, and replacement stages |
| `animationEnabled` | `true` | Use the spinner-style running glyph; when false, use a static triangle |

When automatic remediation is enabled, current watchdog findings are authoritative. Healthy agents are not restarted merely because visible output has paused for less than `progressStaleMs`.

## Validation rules

- Every numeric setting except `parentReservedCpu` must be finite and greater than zero.
- `parentReservedCpu` must be a non-negative integer.
- `criticalFreeMemoryBytes` must not exceed `minimumFreeMemoryBytes`.
- `autoPauseOnCritical`, `autoRemediateStuck`, and `animationEnabled` must be booleans.
- Invalid JSON or an invalid value stops extension initialization with an error instead of silently falling back.

## Recommended changes

- Increase `progressStaleMs` for tasks that legitimately run long, quiet commands.
- Increase `parentReservedMemoryBytes` on machines where the parent model or other Pi extensions need more headroom.
- Increase `minimumFreeDiskBytes` for repositories with large builds or generated artifacts.
- Disable `animationEnabled` to use the static running marker in reduced-motion or low-refresh terminal environments.
- Disable automatic controls only when you have another supervision process; queued work and watchdog diagnostics remain safer than forced concurrency.

Avoid copying the complete defaults into a configuration file. A partial override is easier to review and will not accidentally freeze unrelated settings when defaults change in a future release.
