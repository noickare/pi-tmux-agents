# Contributing

## Development

Requirements: Node.js 22.19+, Git, tmux 3.2+, and pi.

```bash
npm ci
npm run validate
npm run tui:fixtures
npm run smoke:runner
npm run smoke:extension
npm run pack:check
```

Use a focused branch and include tests for behavior changes. TUI changes must be reviewed at narrow and wide terminal widths, remain keyboard accessible, and never emit lines wider than the supplied render width.

## Pull requests

- Explain the user-visible behavior and failure handling.
- Keep process execution argv-based; do not interpolate shell commands.
- Preserve project trust boundaries and restrictive state-file permissions.
- Include cleanup paths for timers, processes, tmux windows, and worktrees.
