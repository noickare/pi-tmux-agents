import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { MainActivityTracker } from "../src/core/main-activity.js";
import { ActivityDashboard } from "../src/ui/activity-dashboard.js";
import { ActivityWidget } from "../src/ui/activity-widget.js";
import { createDashboardViewModel } from "../src/ui/view-model.js";
import { plainTheme, snapshot } from "./fixtures.js";

const now = new Date("2026-07-23T10:02:00.000Z");
const agents = [
  snapshot(),
  snapshot({
    agentId: "scout-1",
    name: "scout-1",
    status: "awaiting_review",
    reviewState: "pending",
    currentTool: undefined,
    task: "Inspect authentication",
    latestResult: {
      resultId: "result-1",
      outcome: "completed",
      assignmentId: "assignment-1",
      attemptId: "attempt-1",
      attemptNumber: 1,
      completedAt: "2026-07-23T10:01:30.000Z",
      finalResponse: "Found and fixed the stale authentication callback.",
      resultPath: "/tmp/result.json",
    },
  }),
  snapshot({ agentId: "reviewer-1", name: "reviewer-1", status: "orphaned", statusReason: "Runner process missing", currentTool: undefined }),
];

function activeMain(): ReturnType<MainActivityTracker["snapshot"]> {
  const tracker = new MainActivityTracker(() => now);
  tracker.reset();
  tracker.agentStarted();
  tracker.turnStarted(12, now.getTime());
  tracker.messageUpdated({ type: "thinking_start", contentIndex: 0, partial: {} as never });
  tracker.messageUpdated({ type: "thinking_delta", contentIndex: 0, delta: "Inspect observable events before choosing a change.", partial: {} as never });
  tracker.messageUpdated({ type: "thinking_end", contentIndex: 0, content: "Inspect observable events before choosing a change.", partial: {} as never });
  tracker.toolStarted("tool-1", "read", { path: "src/index.ts" });
  tracker.toolEnded("tool-1", "read", false);
  return tracker.snapshot();
}

describe("Activity TUI", () => {
  it.each([40, 60, 80, 120, 180])("never exceeds %i columns", (width) => {
    const viewModel = createDashboardViewModel(agents, now, new Date("2026-07-23T10:01:48.000Z"), undefined, { main: activeMain() });
    const dashboard = new ActivityDashboard(viewModel, plainTheme, { close() {} });
    const widget = new ActivityWidget(viewModel, plainTheme);
    for (const line of [...dashboard.render(width), ...widget.render(width)]) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  });

  it("preserves selection by agent id when rows update", () => {
    const viewModel = createDashboardViewModel(agents, now, undefined, undefined, { main: activeMain() });
    let attached: string | undefined;
    const dashboard = new ActivityDashboard(viewModel, plainTheme, { close() {}, attach: (id) => { attached = id; } });
    dashboard.handleInput("j");
    dashboard.setViewModel(createDashboardViewModel([...agents].reverse(), now, undefined, undefined, { main: activeMain() }));
    dashboard.handleInput("o");
    expect(attached).toBe("scout-1");
  });

  it("moves selection when selected work becomes resolved history", () => {
    let attached: string | undefined;
    const dashboard = new ActivityDashboard(createDashboardViewModel(agents, now), plainTheme, { close() {}, attach: (id) => { attached = id; } });
    dashboard.handleInput("j");
    const resolved = agents.map((item) => item.agentId === "scout-1" ? { ...item, status: "closed" as const } : item);
    dashboard.setViewModel(createDashboardViewModel(resolved, now));
    dashboard.handleInput("o");
    expect(attached).toBe("worker-1");
  });

  it("supports direct view navigation and result review actions", () => {
    const actions: string[] = [];
    const dashboard = new ActivityDashboard(createDashboardViewModel(agents, now, undefined, undefined, { main: activeMain() }), plainTheme, {
      close() {},
      openResult: () => actions.push("open"),
      accept: () => actions.push("accept"),
      revise: () => actions.push("revise"),
      takeOver: () => actions.push("take-over"),
      escalate: () => actions.push("escalate"),
      dismiss: () => actions.push("dismiss"),
    });
    dashboard.handleInput("3");
    dashboard.handleInput("j");
    for (const key of ["\r", "a", "r", "t", "e", "d"]) dashboard.handleInput(key);
    expect(actions).toEqual(["open", "accept", "revise", "take-over", "escalate", "dismiss"]);
  });

  it("makes the main agent first class when no delegated work exists", () => {
    const viewModel = createDashboardViewModel([], now, undefined, undefined, { main: activeMain() });
    const widget = new ActivityWidget(viewModel, plainTheme).render(120).join("\n");
    const dashboard = new ActivityDashboard(viewModel, plainTheme, { close() {} }).render(120).join("\n");
    expect(widget).toContain("Main continuing");
    expect(widget).toContain("0 delegated");
    expect(dashboard).toContain("No delegated work in this session");
    expect(dashboard).toContain("mouse unavailable");
  });

  it("shows provider reasoning chronologically and labels its limits", () => {
    const viewModel = createDashboardViewModel([], now, undefined, undefined, { main: activeMain() });
    const dashboard = new ActivityDashboard(viewModel, plainTheme, { close() {} });
    dashboard.handleInput("2");
    const text = dashboard.render(120).join("\n");
    expect(text.indexOf("Inspect observable events")).toBeLessThan(text.indexOf("Tool completed"));
    expect(text).toContain("raw hidden chain-of-thought is not claimed");
  });

  it("keeps the live overlay within its height and pages to the newest events", () => {
    const tracker = new MainActivityTracker(() => now);
    tracker.reset();
    tracker.agentStarted();
    tracker.turnStarted(1, now.getTime());
    for (let index = 0; index < 40; index++) {
      tracker.toolStarted(`tool-${index}`, "read", { index });
      tracker.toolEnded(`tool-${index}`, "read", false);
    }
    const dashboard = new ActivityDashboard(
      createDashboardViewModel([], now, undefined, undefined, { main: tracker.snapshot() }),
      plainTheme,
      { close() {} },
      () => now,
      () => 18,
    );
    dashboard.handleInput("2");
    expect(dashboard.render(80)).toHaveLength(18);
    expect(dashboard.render(80).join("\n")).toContain("PgUp/PgDn scroll");
    for (let index = 0; index < 10; index++) dashboard.handleInput("\x1b[6~");
    const paged = dashboard.render(80).join("\n");
    expect(paged).toContain('{"index":39}');
    expect(paged).toContain("Tab view · c watchdog · Esc close");
  });

  it("keeps terminal children out of the widget and makes resolved history read-only", () => {
    const terminal = [{ ...agents[1]!, agentId: "accepted", name: "accepted", status: "closed" as const, statusReason: "Accepted by parent" }];
    const viewModel = createDashboardViewModel(terminal, now, undefined, undefined, { main: activeMain() });
    expect(new ActivityWidget(viewModel, plainTheme).render(120).join("\n")).not.toContain("accepted");
    const actions: string[] = [];
    const dashboard = new ActivityDashboard(viewModel, plainTheme, {
      close() {},
      openResult: () => actions.push("open"),
      recover: () => actions.push("recover"),
      closeAgent: () => actions.push("close"),
      steer: () => actions.push("steer"),
    });
    dashboard.handleInput("3");
    dashboard.handleInput("h");
    const history = dashboard.render(120).join("\n");
    expect(history).toContain("accepted");
    expect(history).toContain("resolved work is read-only");
    for (const key of ["\r", "r", "d", "s"]) dashboard.handleInput(key);
    expect(actions).toEqual(["open"]);
  });
});
