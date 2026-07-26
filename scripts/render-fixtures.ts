import type { Theme } from "@earendil-works/pi-coding-agent";
import { AgentDashboard } from "../src/ui/dashboard.js";
import { ProgressWidget } from "../src/ui/progress-widget.js";
import { createDashboardViewModel } from "../src/ui/view-model.js";
import { PROTOCOL_VERSION, type AgentSnapshot } from "../src/core/protocol.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

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
  usage: { inputTokens: 1200, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.01 },
  lastSequence: 12,
};
const agents: AgentSnapshot[] = [
  base,
  { ...base, agentId: "scout-1", name: "scout-1", status: "awaiting_review", task: "Inspect auth", currentTool: "3 findings", queuedMessages: 0, reviewState: "pending" },
  { ...base, agentId: "reviewer-3", name: "reviewer-3", status: "blocked", statusReason: "Waiting for worker", currentTool: "Waiting for worker", queuedMessages: 0 },
];
const vm = createDashboardViewModel(agents, new Date("2026-07-23T10:02:00.000Z"), new Date("2026-07-23T10:01:48.000Z"), undefined, {
  config: DEFAULT_CONFIG,
  resources: {
    cpuCount: 12, loadAverage1m: 2.1, totalMemoryBytes: 32 * 1024 ** 3, availableMemoryBytes: 18 * 1024 ** 3,
    availableDiskBytes: 120 * 1024 ** 3, activeWeight: 3.5, parentReservedCpu: 1,
    parentReservedMemoryBytes: 1024 ** 3, providerBackoff: false,
  },
  findings: [{ agentId: "reviewer-3", severity: "warning", kind: "progress_stale", message: "No meaningful progress for 10m" }],
});

const printable = (lines: readonly string[]) => lines.join("\n").replaceAll(/\x1b\[[0-9;]*m/g, "");

for (const width of [40, 120]) {
  const dashboard = new AgentDashboard(vm, theme, { close() {} });
  for (const view of ["overview", "details", "queue", "activity", "resources", "diagnostics", "settings"]) {
    console.log(`\n=== Dashboard ${view} ${width} columns ===`);
    console.log(printable(dashboard.render(width)));
    dashboard.handleInput("\t");
  }
  console.log(`\n=== Widget ${width} columns ===`);
  console.log(printable(new ProgressWidget(vm, theme).render(width)));
}
