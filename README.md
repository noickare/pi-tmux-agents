# pi-tmux-agents

Persistent, steerable, tmux-backed subagents for [pi](https://github.com/earendil-works/pi-mono), with isolated Git worktrees, autonomous parent orchestration, resource-aware scheduling, watchdog supervision, and a polished terminal UI.

> **Status:** Early development. See the [approved PRD](docs/PRD.md).

## Planned capabilities

- Persistent pi agents in readable tmux windows
- Repeated prompts, steering, and follow-up messages
- Dedicated Git worktrees for mutating agents
- Resource-aware scheduling without a fixed agent limit
- Watchdog health checks and periodic parent supervision
- Restart recovery and durable control/event logs
- Responsive, keyboard-first pi TUI dashboard
- Predefined Markdown agents and ad-hoc agents

## Project status

Wave 1 foundations are complete. Wave 2 adds the persistent tmux runner: isolated pi RPC sessions, durable command acknowledgement and replay, readable transcripts, heartbeats, stale-lock recovery, process-group pause/resume, and restart-safe session reuse. Parent orchestration tools and watchdog policy are the next integration track. The full architecture and product requirements are documented in [`docs/PRD.md`](docs/PRD.md).

## Development

```bash
npm install
npm run validate
npm run tui:fixtures
npm run smoke:runner
```

- `npm run validate` runs strict TypeScript checking and the test suite.
- `npm run tui:fixtures` renders narrow and wide dashboard/widget fixtures for visual review.
- `npm run smoke:runner` launches a real detached tmux runner, verifies its RPC heartbeat state, and closes it cleanly without making a model call.
- During development, load the extension with `pi -e ./src/extension/index.ts`.

## License

To be selected before the first release.
