import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Theme } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { MainActivityTracker, type MainActivityPhase, type MainActivitySnapshot } from "../src/core/main-activity.js";
import { PROTOCOL_VERSION, type AgentSnapshot, type AgentStatus } from "../src/core/protocol.js";
import { ActivityDashboard, type ActivityView } from "../src/ui/activity-dashboard.js";
import { ActivityWidget } from "../src/ui/activity-widget.js";
import { createDashboardViewModel } from "../src/ui/view-model.js";

const renderedAt = new Date("2026-08-31T16:42:18.000Z");
const outputDirectory = resolve(process.argv[2] ?? ".omx/artifacts/visual-ralph/activity-ui/actual");
const theme = createTheme();

interface Screen {
  name: string;
  title: string;
  phase: MainActivityPhase;
  view?: ActivityView;
  agents?: AgentSnapshot[];
  selectDown?: number;
  history?: boolean;
  width?: number;
}

const activeAgents = [
  agent({
    agentId: "worker-a41f",
    name: "implementation",
    status: "running",
    task: "Implement the Activity event model and TUI",
    currentTool: "npm test",
    mutating: true,
    worktree: "../.worktrees/worker-a41f",
    model: "openai/gpt-5.5",
    thinkingLevel: "high",
    recentActivity: [
      { at: "2026-08-31T16:40:42.000Z", kind: "reasoning", text: "Verify the public event contract before changing presentation.", state: "complete" },
      { at: "2026-08-31T16:41:03.000Z", kind: "tool", text: "read src/extension/index.ts", state: "complete" },
      { at: "2026-08-31T16:41:49.000Z", kind: "tool", text: "npm test", state: "active" },
    ],
  }),
  agent({
    agentId: "review-b97c",
    name: "API verification",
    status: "awaiting_review",
    task: "Verify every proposed Activity state against Pi 0.84.4",
    currentTool: undefined,
    reviewState: "pending",
    latestResult: {
      resultId: "result-api",
      outcome: "completed",
      assignmentId: "assignment-api",
      attemptId: "attempt-api-1",
      attemptNumber: 1,
      completedAt: "2026-08-31T16:41:36.000Z",
      finalResponse: "Verified lifecycle, message, tool, prompt, and compaction events. Mouse hit-testing and hidden raw chain-of-thought are not exposed.",
      resultPath: "/project/.pi/results/result-api.json",
    },
    recentActivity: [
      { at: "2026-08-31T16:39:54.000Z", kind: "reasoning", text: "Separate provider summaries from unavailable raw reasoning.", state: "complete" },
      { at: "2026-08-31T16:40:26.000Z", kind: "message", text: "Public API verification complete.", state: "complete" },
    ],
  }),
  agent({ agentId: "audit-13dd", name: "watchdog audit", status: "orphaned", task: "Audit supervision recovery", currentTool: undefined, statusReason: "Runner process missing" }),
];

const terminalAgents = [
  agent({ agentId: "accepted-0a1", name: "accepted UI pass", status: "closed", currentTool: undefined, statusReason: "Accepted by parent" }),
  agent({ agentId: "replaced-0b2", name: "superseded audit", status: "replaced", currentTool: undefined, statusReason: "Replaced after watchdog recovery" }),
];

const lifecycleStatuses: AgentStatus[] = [
  "queued", "starting", "idle", "running", "awaiting_review", "retrying", "compacting", "paused", "aborting", "failed", "orphaned", "replaced", "closed",
];
const lifecycleAgents = lifecycleStatuses.map((status, index) => agent({
  agentId: `state-${index.toString().padStart(2, "0")}`,
  name: status.replaceAll("_", " "),
  status,
  currentTool: status === "running" ? "read" : undefined,
  statusReason: status === "awaiting_review" ? "Result awaiting parent review" : status.replaceAll("_", " "),
  ...(status === "awaiting_review" ? {
    reviewState: "pending" as const,
    latestResult: {
      resultId: "state-result",
      outcome: "completed" as const,
      assignmentId: "state-assignment",
      attemptId: "state-attempt",
      attemptNumber: 1,
      completedAt: renderedAt.toISOString(),
      finalResponse: "Lifecycle result ready.",
      resultPath: "/project/.pi/results/state-result.json",
    },
  } : {}),
}));

const screens: Screen[] = [
  { name: "01-solo-ready", title: "Main agent ready · no delegated work", phase: "ready" },
  { name: "02-solo-starting", title: "Main agent starting", phase: "starting" },
  { name: "03-solo-reasoning", title: "Provider reasoning summary · shown by default", phase: "reasoning" },
  { name: "04-solo-tool", title: "Main tool running", phase: "tool", view: "main" },
  { name: "05-solo-responding", title: "Main response streaming", phase: "responding", view: "main" },
  { name: "06-waiting-for-user", title: "Pi UI prompt blocks the run", phase: "waiting", view: "main" },
  { name: "07-compacting", title: "Context compaction and continuation", phase: "compacting", view: "main" },
  { name: "08-main-attention", title: "Observable main-agent failure", phase: "attention", view: "main" },
  { name: "09-delegated-active", title: "Main work plus optional delegated work", phase: "tool", agents: activeAgents },
  { name: "10-delegated-detail", title: "Selected child timeline with faded reasoning", phase: "continuing", view: "delegated", agents: activeAgents },
  { name: "11-result-review", title: "Completed result review actions", phase: "ready", view: "delegated", agents: activeAgents, selectDown: 1 },
  { name: "12-diagnostics", title: "Diagnostics and merged chronological events", phase: "attention", view: "events", agents: activeAgents },
  { name: "13-resolved-history", title: "Resolved delegated history", phase: "ready", view: "delegated", agents: terminalAgents, history: true },
  { name: "14-narrow-navigation", title: "Narrow terminal · explicit keyboard navigation", phase: "reasoning", agents: activeAgents, width: 58 },
  { name: "15-child-lifecycle-catalog", title: "Runtime-produced delegated lifecycle states", phase: "continuing", agents: lifecycleAgents },
];

await mkdir(outputDirectory, { recursive: true });
for (const screen of screens) {
  const columns = screen.width ?? 120;
  const main = mainFor(screen.phase);
  const viewModel = createDashboardViewModel(screen.agents ?? [], renderedAt, new Date("2026-08-31T16:42:06.000Z"), undefined, {
    main,
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
    findings: screen.name === "12-diagnostics"
      ? [
          { agentId: "audit-13dd", severity: "error", kind: "process_missing", message: "Runner process missing" },
          { agentId: "worker-a41f", severity: "warning", kind: "tool_failures", message: "Two recent tool failures" },
        ]
      : [],
  });
  const dashboard = new ActivityDashboard(viewModel, theme, { close() {} }, () => renderedAt);
  if (screen.view) dashboard.handleInput(String(["overview", "main", "delegated", "events"].indexOf(screen.view) + 1));
  for (let index = 0; index < (screen.selectDown ?? 0); index++) dashboard.handleInput("j");
  if (screen.history) dashboard.handleInput("h");
  const dashboardLines = dashboard.render(columns);
  const widgetLines = new ActivityWidget(viewModel, theme).render(columns);
  const html = document(screen.title, columns, dashboardLines, widgetLines);
  await writeFile(resolve(outputDirectory, `${screen.name}.html`), html, "utf8");
}

await writeFile(resolve(outputDirectory, "manifest.json"), JSON.stringify({ generatedAt: new Date().toISOString(), screens: screens.map(({ name, title, phase, view, width }) => ({ name, title, phase, view: view ?? "overview", columns: width ?? 120 })) }, null, 2) + "\n", "utf8");
console.log(outputDirectory);

function mainFor(phase: MainActivityPhase): MainActivitySnapshot {
  let tick = 0;
  const tracker = new MainActivityTracker(() => new Date(renderedAt.getTime() - 95_000 + tick++ * 4_000));
  tracker.reset();
  if (phase === "ready") return tracker.snapshot();
  tracker.agentStarted();
  if (phase === "starting") return tracker.snapshot();
  tracker.turnStarted(12);
  if (["reasoning", "tool", "responding", "waiting", "compacting", "continuing", "attention"].includes(phase)) {
    tracker.messageUpdated({ type: "thinking_start", contentIndex: 0, partial: {} as never });
    tracker.messageUpdated({ type: "thinking_delta", contentIndex: 0, delta: "Inspect observable Pi events and preserve their actual order.", partial: {} as never });
    if (phase === "reasoning") return tracker.snapshot();
    tracker.messageUpdated({ type: "thinking_end", contentIndex: 0, content: "Inspect observable Pi events and preserve their actual order.", partial: {} as never });
  }
  if (phase === "tool" || phase === "waiting" || phase === "compacting" || phase === "attention") tracker.toolStarted("read-1", "read", { path: "src/extension/index.ts", lines: "368-409" });
  if (phase === "tool") return tracker.snapshot();
  if (phase === "responding") {
    tracker.messageUpdated({ type: "text_start", contentIndex: 1, partial: {} as never });
    tracker.messageUpdated({ type: "text_delta", contentIndex: 1, delta: "The Activity stream now follows the public event sequence.", partial: {} as never });
    return tracker.snapshot();
  }
  if (phase === "waiting") {
    tracker.toolEnded("read-1", "read", false);
    tracker.promptStarted("confirm", "Apply the selected result?");
    return tracker.snapshot();
  }
  if (phase === "compacting") {
    tracker.toolEnded("read-1", "read", false);
    tracker.compactionStarted("threshold", true);
    return tracker.snapshot();
  }
  if (phase === "attention") {
    tracker.toolEnded("read-1", "read", true);
    return tracker.snapshot();
  }
  return tracker.snapshot();
}

function agent(overrides: Omit<Partial<AgentSnapshot>, "currentTool"> & { agentId: string; name: string; status: AgentStatus; currentTool?: string | undefined }): AgentSnapshot {
  const { agentId, name, status, currentTool, ...rest } = overrides;
  const base: AgentSnapshot = {
    protocolVersion: PROTOCOL_VERSION,
    agentId,
    name,
    status,
    cwd: "/project",
    task: "Inspect and report observable work",
    currentTool: "read",
    startedAt: "2026-08-31T16:38:00.000Z",
    updatedAt: "2026-08-31T16:42:00.000Z",
    lastHeartbeatAt: "2026-08-31T16:42:14.000Z",
    lastProgressAt: "2026-08-31T16:41:49.000Z",
    nextParentReviewAt: "2026-08-31T16:45:00.000Z",
    queuedMessages: 0,
    usage: { inputTokens: 1_280, outputTokens: 420, cacheReadTokens: 320, cacheWriteTokens: 0, cost: 0.018 },
    lastSequence: 21,
    ...rest,
  };
  if (currentTool === undefined) delete base.currentTool;
  else base.currentTool = currentTool;
  return base;
}

function createTheme(): Theme {
  const foregroundNames = [
    "accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "muted", "dim", "text", "thinkingText", "searchMatchText", "userMessageText", "customMessageText", "customMessageLabel", "toolTitle", "toolOutput", "mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder", "mdHr", "mdListBullet", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext", "syntaxComment", "syntaxKeyword", "syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation", "thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "thinkingMax", "bashMode",
  ];
  const foreground = Object.fromEntries(foregroundNames.map((name) => [name, color(name)]));
  const background = {
    selectedBg: "#343449",
    scrollbarThumb: "#343449",
    searchMatchBg: "#343449",
    userMessageBg: "#262b39",
    customMessageBg: "#121722",
    toolPendingBg: "#262634",
    toolSuccessBg: "#203028",
    toolErrorBg: "#38242a",
  };
  return new Theme(foreground as never, background, "truecolor", { name: "activity-gallery" });
}

function color(name: string): string {
  if (name === "accent" || name.startsWith("thinkingH") || name.startsWith("thinkingX")) return "#a78bfa";
  if (name === "success" || name === "toolDiffAdded") return "#7dd3a3";
  if (name === "error" || name === "toolDiffRemoved") return "#f27c91";
  if (name === "warning" || name === "mdHeading") return "#e5bd68";
  if (name === "thinkingText" || name === "toolOutput" || name === "mdQuote") return "#697287";
  if (name === "muted") return "#8b94a8";
  if (name === "dim" || name === "borderMuted") return "#596174";
  if (name === "toolTitle" || name === "syntaxKeyword") return "#b69cff";
  if (name === "text" || name.endsWith("Text")) return "#d7dbea";
  return "#8791a8";
}

function document(title: string, columns: number, dashboardLines: readonly string[], widgetLines: readonly string[]): string {
  const width = columns * 9.65 + 48;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
*{box-sizing:border-box}html,body{margin:0;background:#090c13;color:#d7dbea}body{padding:22px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}.capture{width:${width}px}.context{height:38px;padding:8px 13px;background:#0d111a;border:1px solid #222a39;border-bottom:0;color:#717b91;font-size:13px}.context strong{color:#c9cfdf;font-weight:600}.panel{border:1px solid #30394a;box-shadow:0 18px 60px #0008}.label{padding:9px 13px;background:#111623;border-bottom:1px solid #30394a;color:#9ca6bb;font-size:13px}.label b{color:#d7dbea}.terminal{margin:0;padding:0;font-size:15px;line-height:1.42;white-space:pre;overflow:hidden;background:#121722}.widget{margin-top:10px;padding:8px 12px;background:#0d111a;border:1px solid #293144;font-size:14px;line-height:1.35;white-space:pre}.note{margin-top:8px;color:#586176;font-size:12px}span{font-variant-ligatures:none}
</style></head><body><main class="capture"><div class="context"><strong>Pi 0.84.4</strong> · /activity · ${escapeHtml(title)}</div><section class="panel"><div class="label"><b>Activity</b> · actual component render · ${columns} columns</div><pre class="terminal">${ansiToHtml(dashboardLines.join("\n"))}</pre></section><pre class="widget">${ansiToHtml(widgetLines.join("\n"))}</pre><div class="note">Keyboard surface: Ctrl+Alt+A open · Tab / Shift+Tab views · 1–4 jump · ↑↓ select · Page Up/Down scroll · Enter inspect · Esc close</div></main></body></html>`;
}

function ansiToHtml(value: string): string {
  const pattern = /\x1b\[([0-9;]*)m/g;
  let cursor = 0;
  let result = "";
  const state: { color?: string; background?: string; bold: boolean; italic: boolean } = { bold: false, italic: false };
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? cursor;
    result += styled(escapeHtml(value.slice(cursor, index)), state);
    const codes = (match[1] || "0").split(";").map(Number);
    for (let codeIndex = 0; codeIndex < codes.length; codeIndex++) {
      const code = codes[codeIndex] ?? 0;
      if (code === 0) { delete state.color; delete state.background; state.bold = false; state.italic = false; }
      else if (code === 1) state.bold = true;
      else if (code === 3) state.italic = true;
      else if (code === 22) state.bold = false;
      else if (code === 23) state.italic = false;
      else if ((code === 38 || code === 48) && codes[codeIndex + 1] === 2) {
        const rgb = `rgb(${codes[codeIndex + 2]},${codes[codeIndex + 3]},${codes[codeIndex + 4]})`;
        if (code === 38) state.color = rgb; else state.background = rgb;
        codeIndex += 4;
      } else if (code === 39) delete state.color;
      else if (code === 49) delete state.background;
    }
    cursor = index + match[0].length;
  }
  return result + styled(escapeHtml(value.slice(cursor)), state);
}

function styled(value: string, state: { color?: string; background?: string; bold: boolean; italic: boolean }): string {
  if (!value) return "";
  const styles = [state.color && `color:${state.color}`, state.background && `background:${state.background}`, state.bold && "font-weight:700", state.italic && "font-style:italic"].filter(Boolean).join(";");
  return styles ? `<span style="${styles}">${value}</span>` : value;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
