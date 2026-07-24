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

Wave 1 foundations are under development: typed lifecycle and control contracts, durable state storage, tmux and worktree adapters, resource-aware admission, agent discovery, and responsive TUI components. The full architecture and product requirements are documented in [`docs/PRD.md`](docs/PRD.md).

## Development

```bash
npm install
npm run validate
npm run tui:fixtures
```

- `npm run validate` runs strict TypeScript checking and the test suite.
- `npm run tui:fixtures` renders narrow and wide dashboard/widget fixtures for visual review.
- During development, load the extension with `pi -e ./src/extension/index.ts`.

## License

To be selected before the first release.
