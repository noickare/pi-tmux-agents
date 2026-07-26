import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AgentDashboard } from "../src/ui/dashboard.js";
import { ProgressWidget } from "../src/ui/progress-widget.js";
import { createDashboardViewModel } from "../src/ui/view-model.js";
import { plainTheme, snapshot } from "./fixtures.js";

const now = new Date("2026-07-23T10:02:00.000Z");
const agents = [
  snapshot(),
  snapshot({ agentId: "scout-1", name: "scout-1", status: "awaiting_review", reviewState: "pending", currentTool: undefined, task: "Inspect authentication" }),
  snapshot({ agentId: "reviewer-1", name: "reviewer-1", status: "blocked", statusReason: "Waiting for worker", currentTool: undefined }),
];

describe("TUI foundations", () => {
  it.each([40, 60, 80, 120, 180])("never exceeds %i columns", (width) => {
    const viewModel = createDashboardViewModel(agents, now, new Date("2026-07-23T10:01:48.000Z"));
    const dashboard = new AgentDashboard(viewModel, plainTheme, { close() {} });
    const widget = new ProgressWidget(viewModel, plainTheme);
    for (const line of [...dashboard.render(width), ...widget.render(width)]) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("preserves selection by agent id when rows update", () => {
    const viewModel = createDashboardViewModel(agents, now);
    let attached: string | undefined;
    const dashboard = new AgentDashboard(viewModel, plainTheme, { close() {}, attach: (id) => { attached = id; } });
    dashboard.handleInput("j");
    dashboard.setViewModel(createDashboardViewModel([...agents].reverse(), now));
    dashboard.handleInput("o");
    expect(attached).toBe("scout-1");
  });

  it("keeps every dashboard view within width and exposes keyboard actions", () => {
    const viewModel = createDashboardViewModel(agents, now);
    const actions: string[] = [];
    const dashboard = new AgentDashboard(viewModel, plainTheme, {
      close() {},
      followUp: () => actions.push("follow-up"),
      togglePause: () => actions.push("pause"),
      recover: () => actions.push("recover"),
      closeAgent: () => actions.push("close-agent"),
    });
    for (let index = 0; index < 7; index++) {
      for (const line of dashboard.render(40)) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
      dashboard.handleInput("\t");
    }
    for (const key of ["f", "p", "r", "d"]) dashboard.handleInput(key);
    expect(actions).toEqual(["follow-up", "pause", "recover", "close-agent"]);
  });

  it("distinguishes a result awaiting parent review from an unused idle session", () => {
    const awaitingReview = snapshot({
      status: "awaiting_review", currentTool: undefined, statusReason: "Result awaiting parent review",
      lastCompletedAt: "2026-07-23T10:01:30.000Z", reviewState: "pending",
    });
    const [row] = createDashboardViewModel([awaitingReview], now).rows;
    expect(row).toMatchObject({ icon: "◆", statusLabel: "Awaiting parent review", completedAssignment: true });
  });

  it("renders explicit review timing and attention state", () => {
    const viewModel = createDashboardViewModel(agents, now, new Date("2026-07-23T10:01:48.000Z"));
    const text = new ProgressWidget(viewModel, plainTheme).render(120).join("\n");
    expect(text).toContain("pending review/attention");
    expect(text).toContain("Parent review in 03:00");
    expect(text).toContain("watchdog checked 00:12 ago");
  });
});
