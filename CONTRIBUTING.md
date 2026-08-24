# Contributing

Thank you for improving `pi-tmux-agents`. Bug fixes, tests, documentation, and focused feature proposals are welcome.

## Before you start

- Search [existing issues](https://github.com/noickare/pi-tmux-agents/issues) before opening a new one.
- Open an issue before a substantial behavioral or architectural change so the approach can be discussed.
- Report vulnerabilities privately according to [SECURITY.md](SECURITY.md), not in a public issue.
- Keep project discussions respectful, specific, and focused on the work.

## Development setup

Requirements are listed in the [README](README.md). Clone your fork, then install the locked dependencies:

```bash
npm ci
```

Run the extension directly from the checkout:

```bash
pi -e ./src/extension/index.ts
```

Inside Pi, run `/agents-doctor` before testing live child sessions.

## Repository layout

```text
src/core/       Protocol, configuration, registry, state, and agent definitions
src/runner/     Persistent child runner and Pi RPC transport
src/services/   Orchestration, tmux, worktrees, scheduler, watchdog, and diagnostics
src/ui/         Dashboard, progress widget, and view models
test/           Unit and integration tests
scripts/        Smoke tests, fixtures, and package checks
docs/           User, architecture, update, and maintainer documentation
```

See [Architecture](docs/ARCHITECTURE.md) before changing lifecycle, persistence, scheduling, or recovery behavior.

## Validation commands

Run the narrowest relevant test while developing, then run the complete checks before opening a pull request.

| Command | Purpose |
| --- | --- |
| `npm run check` | Verify coordinated Pi host versions and TypeScript types |
| `npm test` | Run the Vitest suite once |
| `npm run validate` | Run `check` and the full test suite |
| `npm run tui:fixtures` | Render dashboard and widget fixtures for manual inspection |
| `npm run smoke:runner` | Exercise a live persistent runner |
| `npm run smoke:extension` | Exercise extension startup and integration |
| `npm run pack:check` | Inspect the package contents with `npm pack --dry-run` |
| `npm audit --omit=dev` | Check runtime dependencies for known vulnerabilities |

The GitHub Actions workflow runs supported Node.js versions and repeats the validation, smoke, package, and audit checks.

## Engineering expectations

- Keep changes small and modular; remove obsolete paths instead of adding compatibility layers.
- Preserve strict TypeScript settings, including exact optional properties and unchecked-index handling.
- Keep process execution argv-based. Do not interpolate user-controlled values into shell commands.
- Preserve project-trust boundaries and restrictive permissions for runtime state.
- Include deterministic cleanup for timers, processes, tmux windows, locks, and worktrees.
- Add or update tests for behavior changes and failure paths.
- Update public documentation and `CHANGELOG.md` when users need to act differently.
- Do not add a dependency when an existing project or Pi API already provides the capability.

TUI changes must be reviewed at narrow and wide terminal widths, remain keyboard accessible, use injected theme tokens, and never emit a line wider than the supplied render width.

## Pull requests

A pull request should:

1. Explain the problem and user-visible behavior.
2. Describe failure handling, trust implications, and cleanup when relevant.
3. Link the issue or rationale for the change.
4. Include tests and documentation updates.
5. Pass `npm run validate`, both smoke tests, and `npm run pack:check`.
6. Avoid unrelated formatting or refactoring.

Maintainers may ask for a change to be split when review, rollback, or release risk would otherwise be unclear.

## Release changes

Maintainers should follow [docs/RELEASING.md](docs/RELEASING.md). Pi host packages must move together, compatibility must be validated before a new immutable tag is published, and published tags must never be moved.

## License

By submitting a contribution, you agree that it is licensed under the repository's [MIT License](LICENSE).
