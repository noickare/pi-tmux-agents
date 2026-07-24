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

The persistent runner and parent orchestration path are implemented: isolated pi RPC sessions, durable command replay, readable tmux transcripts, worktree isolation, resource-aware admission queues, live snapshot monitoring, watchdog checks, parent supervision, and responsive dashboard actions. Remaining release work focuses on setup/doctor automation, CI, packaging verification, and expanded end-to-end failure tests. The full architecture and product requirements are documented in [`docs/PRD.md`](docs/PRD.md).

## Development

```bash
npm install
npm run validate
npm run tui:fixtures
npm run smoke:runner
npm run smoke:extension
```

- `npm run validate` runs strict TypeScript checking and the test suite.
- `npm run tui:fixtures` renders narrow and wide dashboard/widget fixtures for visual review.
- `npm run smoke:runner` launches a real detached tmux runner, verifies its RPC heartbeat state, and closes it cleanly without making a model call.
- `npm run smoke:extension` loads the extension in pi RPC mode and invokes its watchdog command without making a model call.
- During development, load the extension with `pi -e ./src/extension/index.ts`.

## License

To be selected before the first release.
