import type { Theme } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { MainActivityTracker } from "../src/core/main-activity.js";
import { PROTOCOL_VERSION, type AgentSnapshot } from "../src/core/protocol.js";
import { ActivityDashboard } from "../src/ui/activity-dashboard.js";
import { ActivityWidget } from "../src/ui/activity-widget.js";
import { createDashboardViewModel } from "../src/ui/view-model.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;

const renderedAt = new Date("2026-07-23T10:02:00.000Z");
const tracker = new MainActivityTracker(() => renderedAt);
tracker.reset();
tracker.agentStarted();
tracker.turnStarted(12, renderedAt.getTime());
tracker.messageUpdated({ type: "thinking_start", contentIndex: 0, partial: {} as never });
tracker.messageUpdated({ type: "thinking_delta", contentIndex: 0, delta: "Inspect the observable state before choosing the next operation.", partial: {} as never });
tracker.messageUpdated({ type: "thinking_end", contentIndex: 0, content: "Inspect the observable state before choosing the next operation.", partial: {} as never });
tracker.toolStarted("tool-1", "read", { path: "src/extension/index.ts", line: 160 });

const base: AgentSnapshot = {
  protocolVersion: PROTOCOL_VERSION,
  agentId: "worker-2",
  name: "worker-2",
  status: "running",
  task: "Implement persistent RPC runner and recovery",
  currentTool: "$ npm test",
  cwd: "/project",
  worktree: "../.worktrees/worker-2",
  tmuxTarget: "pi-agents-parent:worker-2",
  startedAt: "2026-07-23T10:00:00.000Z",
  updatedAt: "2026-07-23T10:01:00.000Z",
  lastHeartbeatAt: "2026-07-23T10:01:58.000Z",
  lastProgressAt: "2026-07-23T10:01:40.000Z",
  nextParentReviewAt: "2026-07-23T10:05:00.000Z",
  queuedMessages: 2,
  recentActivity: [
    { at: "2026-07-23T10:01:12.000Z", kind: "reasoning", text: "Check the retry boundary before changing runner state.", state: "complete" },
    { at: "2026-07-23T10:01:24.000Z", kind: "tool", text: "read src/runner/persistent-runner.ts", state: "complete" },
    { at: "2026-07-23T10:01:40.000Z", kind: "tool", text: "npm test", state: "active" },
  ],
  usage: { inputTokens: 1_200, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.01 },
  lastSequence: 12,
};
const { currentTool: _currentTool, ...withoutCurrentTool } = base;

const agents: AgentSnapshot[] = [
  base,
  {
    ...withoutCurrentTool,
    agentId: "scout-1",
    name: "scout-1",
    status: "awaiting_review",
    task: "Inspect auth",
    queuedMessages: 0,
    reviewState: "pending",
    latestResult: {
      resultId: "result-1",
      outcome: "completed",
      assignmentId: "assignment-1",
      attemptId: "attempt-1",
      attemptNumber: 1,
      completedAt: "2026-07-23T10:01:42.000Z",
      finalResponse: "Found the stale callback and added a focused regression test.",
      resultPath: "/project/.pi/result-1.json",
    },
  },
  { ...withoutCurrentTool, agentId: "reviewer-3", name: "reviewer-3", status: "orphaned", statusReason: "Runner process missing", queuedMessages: 0 },
];

const viewModel = createDashboardViewModel(agents, renderedAt, new Date("2026-07-23T10:01:48.000Z"), undefined, {
  main: tracker.snapshot(),
  config: DEFAULT_CONFIG,
  resources: {
    cpuCount: 12,
    loadAverage1m: 2.1,
    totalMemoryBytes: 32 * 1024 ** 3,
    availableMemoryBytes: 18 * 1024 ** 3,
    availableDiskBytes: 120 * 1024 ** 3,
    activeWeight: 3.5,
    parentReservedCpu: 1,
    parentReservedMemoryBytes: 1024 ** 3,
    providerBackoff: false,
  },
  findings: [{ agentId: "reviewer-3", severity: "warning", kind: "process_missing", message: "Runner process missing" }],
});

for (const width of [40, 120]) {
  const dashboard = new ActivityDashboard(viewModel, theme, { close() {} }, () => renderedAt);
  for (const view of ["overview", "main", "delegated", "events"]) {
    console.log(`\n=== Activity ${view} ${width} columns ===`);
    console.log(dashboard.render(width).join("\n"));
    dashboard.handleInput("\t");
  }
  console.log(`\n=== Widget ${width} columns ===`);
  console.log(new ActivityWidget(viewModel, theme).render(width).join("\n"));
}
