import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { MainActivityEvent, MainActivityPhase } from "../core/main-activity.js";
import type { AgentActivity } from "../core/protocol.js";
import type { AgentRowViewModel, DashboardViewModel } from "./view-model.js";

export type ActivityView = "overview" | "main" | "delegated" | "events";
const VIEWS: readonly ActivityView[] = ["overview", "main", "delegated", "events"];

export interface ActivityActions {
  close(): void;
  attach?(agentId: string): void;
  openResult?(agentId: string): void;
  checkNow?(): void;
  steer?(agentId: string): void;
  followUp?(agentId: string): void;
  togglePause?(agentId: string, paused: boolean): void;
  recover?(agentId: string): void;
  abort?(agentId: string): void;
  closeAgent?(agentId: string): void;
  accept?(agentId: string): void;
  revise?(agentId: string): void;
  takeOver?(agentId: string): void;
  escalate?(agentId: string): void;
  dismiss?(agentId: string): void;
}

export class ActivityDashboard implements Component {
  private selectedId: string | undefined;
  private view: ActivityView = "overview";
  private showHistory = false;
  private scrollOffset = 0;
  private renderedBodyLines = 0;
  private renderedBodyCapacity = 0;

  constructor(
    private viewModel: DashboardViewModel,
    private readonly theme: Theme,
    private readonly actions: ActivityActions,
    private readonly now: () => Date = () => new Date(),
    private readonly maxVisibleLines: () => number = () => Number.POSITIVE_INFINITY,
  ) {
    this.selectedId = this.selectableRows()[0]?.id;
  }

  setViewModel(viewModel: DashboardViewModel): void {
    this.viewModel = viewModel;
    if (!this.selectedId || !this.selectableRows().some((row) => row.id === this.selectedId)) {
      this.selectedId = this.selectableRows()[0]?.id;
      this.scrollOffset = 0;
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) { this.actions.close(); return; }
    if (matchesKey(data, Key.pageUp)) { this.scrollPage(-1); return; }
    if (matchesKey(data, Key.pageDown)) { this.scrollPage(1); return; }
    if (matchesKey(data, Key.tab)) { this.cycleView(1); return; }
    if (matchesKey(data, Key.shift("tab"))) { this.cycleView(-1); return; }
    if (matchesKey(data, Key.left)) { this.cycleView(-1); return; }
    if (matchesKey(data, Key.right)) { this.cycleView(1); return; }
    const direct = (["1", "2", "3", "4"] as const).findIndex((key) => matchesKey(data, key));
    if (direct >= 0) { this.setView(VIEWS[direct] ?? "overview"); return; }
    if (matchesKey(data, "h") && this.view === "delegated") {
      this.showHistory = !this.showHistory;
      if (!this.selectableRows().some((row) => row.id === this.selectedId)) this.selectedId = this.selectableRows()[0]?.id;
      this.scrollOffset = 0;
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (this.view === "overview" && this.selectedId) { this.setView("delegated"); return; }
      if (this.view === "delegated" && this.selected()?.latestResult && this.selectedId) this.actions.openResult?.(this.selectedId);
      return;
    }
    if (matchesKey(data, "c")) { this.actions.checkNow?.(); return; }
    const rows = this.selectableRows();
    const index = Math.max(0, rows.findIndex((row) => row.id === this.selectedId));
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) { this.select(rows, index - 1); return; }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) { this.select(rows, index + 1); return; }
    if (this.selected()?.terminal) return;
    if (matchesKey(data, "o") && this.selectedId) this.actions.attach?.(this.selectedId);
    else if (matchesKey(data, "s") && this.selectedId) this.actions.steer?.(this.selectedId);
    else if (matchesKey(data, "f") && this.selectedId) this.actions.followUp?.(this.selectedId);
    else if (matchesKey(data, "p") && this.selectedId) this.actions.togglePause?.(this.selectedId, this.selected()?.status === "paused");
    else if (matchesKey(data, "r") && this.selectedId) this.selected()?.completedAssignment ? this.actions.revise?.(this.selectedId) : this.actions.recover?.(this.selectedId);
    else if (matchesKey(data, "a") && this.selectedId && this.selected()?.completedAssignment) this.actions.accept?.(this.selectedId);
    else if (matchesKey(data, "t") && this.selectedId && this.selected()?.completedAssignment) this.actions.takeOver?.(this.selectedId);
    else if (matchesKey(data, "e") && this.selectedId && this.selected()?.completedAssignment) this.actions.escalate?.(this.selectedId);
    else if (matchesKey(data, "x") && this.selectedId) this.actions.abort?.(this.selectedId);
    else if (matchesKey(data, "d") && this.selectedId) this.selected()?.completedAssignment ? this.actions.dismiss?.(this.selectedId) : this.actions.closeAgent?.(this.selectedId);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const header = this.header(safeWidth);
    const body = this.renderView(safeWidth);
    const requestedLines = Math.floor(this.maxVisibleLines());
    const maxLines = Number.isFinite(requestedLines) ? Math.max(1, requestedLines) : Number.POSITIVE_INFINITY;
    const fixedLines = header.length + 3;
    if (maxLines < fixedLines) {
      const compact = [header[0] ?? "", header[1] ?? "", this.footer(safeWidth)].slice(0, maxLines);
      return compact.map((line) => this.paint(line, safeWidth));
    }

    const unpagedCapacity = maxLines - fixedLines;
    const showPaging = body.length > unpagedCapacity && maxLines >= fixedLines + 2;
    const bodyCapacity = Math.max(0, unpagedCapacity - (showPaging ? 1 : 0));
    const maximumOffset = Math.max(0, body.length - bodyCapacity);
    this.scrollOffset = Math.min(this.scrollOffset, maximumOffset);
    this.renderedBodyLines = body.length;
    this.renderedBodyCapacity = bodyCapacity;
    const visibleBody = body.slice(this.scrollOffset, this.scrollOffset + bodyCapacity);
    const paging = showPaging
      ? [this.theme.fg("dim", `lines ${this.scrollOffset + 1}–${Math.min(body.length, this.scrollOffset + bodyCapacity)} of ${body.length} · PgUp/PgDn scroll`)]
      : [];
    const lines = [...header, "", ...visibleBody, ...paging, "", this.footer(safeWidth)];
    return lines.map((line) => this.paint(line, safeWidth));
  }

  invalidate(): void {}

  private header(width: number): string[] {
    const main = this.viewModel.main;
    const elapsed = main.startedAt ? ` · ${formatElapsed(main.startedAt, this.now())}` : "";
    const title = this.theme.fg("text", this.theme.bold("Activity")) + "  " + phaseIcon(main.phase, this.theme) + this.theme.fg(phaseColor(main.phase), ` main ${main.phaseLabel}${elapsed}`);
    const tabs = VIEWS.map((view, index) => {
      const label = `${index + 1} ${titleCase(view)}`;
      return view === this.view ? this.theme.fg("accent", this.theme.bold(`[${label}]`)) : this.theme.fg("muted", ` ${label} `);
    }).join("  ");
    const navigation = width < 72
      ? "Tab view · 1–4 · ↑↓ select · PgUp/PgDn · Esc close"
      : "Tab/Shift+Tab view · 1–4 jump · ↑↓/j/k select · PgUp/PgDn scroll · Enter inspect · Esc close · mouse unavailable";
    return [truncateToWidth(title, width), truncateToWidth(tabs, width), truncateToWidth(this.theme.fg("dim", navigation), width)];
  }

  private renderView(width: number): string[] {
    if (this.view === "main") return this.renderMain(width);
    if (this.view === "delegated") return this.renderDelegated(width);
    if (this.view === "events") return this.renderEvents(width);
    return this.renderOverview(width);
  }

  private renderOverview(width: number): string[] {
    const main = this.viewModel.main;
    const rows = this.viewModel.rows.filter((row) => !row.terminal);
    const output = [
      this.sectionTitle("Main"),
      `${phaseIcon(main.phase, this.theme)} ${this.theme.fg(phaseColor(main.phase), main.phaseLabel)}  ${this.theme.fg("muted", main.current)}`,
      ...(main.turnIndex === undefined ? [] : [this.theme.fg("dim", `turn ${main.turnIndex} · ${main.activeTools.length} active tool${main.activeTools.length === 1 ? "" : "s"}`)]),
      "",
      this.sectionTitle("Delegated"),
    ];
    if (!rows.length) output.push(this.theme.fg("muted", "No delegated work in this session. Main activity remains available."));
    else output.push(...rows.map((row) => this.renderAgentRow(row, width)));
    output.push("", this.sectionTitle("Recent main activity · oldest → newest"));
    const recent = main.timeline.slice(-8);
    if (!recent.length) output.push(this.theme.fg("muted", "No main-run events yet."));
    else for (const event of recent) output.push(...this.renderMainEvent(event, width));
    output.push("", this.sectionTitle("Supervision"));
    output.push(this.theme.fg("muted", `watchdog ${this.viewModel.watchdogText} · next ${this.viewModel.nextWatchdogText} · parent review ${this.viewModel.parentReviewText}`));
    if (this.viewModel.resourceLines[0]) output.push(this.theme.fg("dim", this.viewModel.resourceLines[0]));
    return output.flatMap((line) => wrapTextWithAnsi(line, width));
  }

  private renderMain(width: number): string[] {
    const main = this.viewModel.main;
    const lines = [
      this.theme.fg("dim", "Observable Pi events only. Reasoning entries are provider output; raw hidden chain-of-thought is not claimed."),
      "",
      this.sectionTitle("Current event"),
      ...this.keyValues([
        ["phase", main.phaseLabel],
        ["activity", main.current],
        ...(main.turnIndex === undefined ? [] : [["turn", String(main.turnIndex)] as const]),
        ...(main.prompt ? [["prompt", `${main.prompt.kind}${main.prompt.title ? ` · ${main.prompt.title}` : ""}`] as const] : []),
        ...(main.compaction ? [["compaction", `${main.compaction.reason}${main.compaction.willRetry ? " · will continue" : ""}`] as const] : []),
      ], width),
    ];
    if (main.activeTools.length) {
      lines.push("", this.sectionTitle("Active tools"));
      for (const tool of main.activeTools) lines.push(...wrapTextWithAnsi(`${this.theme.fg("toolTitle", tool.name)}  ${this.theme.fg("muted", tool.args || "arguments unavailable")}`, width));
    }
    lines.push("", this.sectionTitle("Timeline · oldest → newest"));
    const events = main.timeline.slice(-28);
    if (!events.length) lines.push(this.theme.fg("muted", "No main-run events yet."));
    else for (const event of events) lines.push(...this.renderMainEvent(event, width));
    return lines;
  }

  private renderDelegated(width: number): string[] {
    const rows = this.selectableRows();
    const selected = this.selected();
    if (!rows.length) return [
      this.theme.fg("muted", this.showHistory ? "No resolved delegated work in this session." : "No live delegated work. Press h to view resolved history."),
    ];
    const listWidth = width >= 88 ? Math.max(30, Math.min(42, Math.floor(width * 0.4))) : width;
    const list = [
      this.sectionTitle(this.showHistory ? "Resolved work" : "Live work"),
      ...rows.map((row) => this.renderAgentRow(row, listWidth)),
    ];
    if (width < 88) return [...list, "", ...(selected ? this.renderAgentDetails(selected, width) : [])];
    const gap = 3;
    const detailWidth = width - listWidth - gap;
    const details = selected ? this.renderAgentDetails(selected, detailWidth) : [this.theme.fg("muted", "Select delegated work to inspect it.")];
    const height = Math.max(list.length, details.length);
    return Array.from({ length: height }, (_, index) => `${pad(list[index] ?? "", listWidth)}${" ".repeat(gap)}${details[index] ?? ""}`);
  }

  private renderAgentDetails(row: AgentRowViewModel, width: number): string[] {
    const lines = [
      this.sectionTitle(`${row.name} · ${row.statusLabel}`),
      ...this.keyValues([
        ["assigned task", row.task],
        ["current", row.currentActivity],
        ["activity", `progress ${row.progressAge} · heartbeat ${row.heartbeatAge}`],
        ...(row.model ? [["model", `${row.model}${row.thinkingLevel ? ` · ${row.thinkingLevel}` : ""}`] as const] : []),
        ["workspace", row.worktree ?? (row.mutating ? "isolated worktree" : "current checkout")],
      ], width),
    ];
    if (row.latestResult) {
      lines.push("", this.sectionTitle(row.completedAssignment ? "Result ready" : "Final result"));
      lines.push(...wrapTextWithAnsi(this.theme.fg("success", compact(row.latestResult.finalResponse, 500)), width));
      lines.push(this.theme.fg("dim", `${row.latestResult.outcome} · ${row.latestResult.completedAt} · attempt ${row.latestResult.attemptNumber}`));
      const actions = row.completedAssignment
        ? "Enter open result · a accept · r revise · t take over · e escalate · d dismiss"
        : "Enter open result · resolved work is read-only";
      lines.push(...wrapTextWithAnsi(this.theme.fg("muted", actions), width));
    }
    lines.push("", this.sectionTitle("Timeline · oldest → newest"));
    if (!row.activity.length) lines.push(this.theme.fg("muted", "No recent child activity."));
    else for (const event of row.activity.slice(-20)) lines.push(...this.renderChildEvent(event, width));
    lines.push("", ...wrapTextWithAnsi(this.theme.fg("dim", "Provider reasoning is faded and bounded. Raw hidden chain-of-thought is unavailable."), width));
    return lines;
  }

  private renderEvents(width: number): string[] {
    const lines = [this.sectionTitle("Diagnostics")];
    if (!this.viewModel.diagnostics.length) lines.push(this.theme.fg("success", "No current watchdog findings."));
    else {
      for (const finding of this.viewModel.diagnostics) {
        const color = finding.severity === "error" ? "error" : "warning";
        lines.push(...wrapTextWithAnsi(this.theme.fg(color, `${finding.severity === "error" ? "!" : "·"} ${finding.agentId} · ${finding.kind}`) + this.theme.fg("muted", `  ${finding.message}`), width));
      }
    }
    lines.push("", this.sectionTitle("Session events · oldest → newest"));
    const events = [
      ...this.viewModel.main.timeline.map((event) => ({ at: event.at, source: "main", kind: event.label, text: event.text, reasoning: event.kind === "reasoning", error: event.state === "error" })),
      ...this.viewModel.rows.flatMap((row) => row.activity.map((event) => ({ at: event.at, source: row.name, kind: event.kind, text: event.text, reasoning: event.kind === "reasoning", error: event.state === "error" }))),
    ].sort((left, right) => left.at.localeCompare(right.at)).slice(-32);
    if (!events.length) lines.push(this.theme.fg("muted", "No activity events yet."));
    for (const event of events) {
      const prefix = `${clock(event.at)} ${event.source} · ${event.kind}`;
      const color = event.error ? "error" : event.reasoning ? "thinkingText" : "muted";
      const value = event.reasoning ? this.theme.italic(`${prefix}  ${event.text}`) : `${prefix}  ${event.text}`;
      lines.push(...wrapTextWithAnsi(this.theme.fg(color, value), width));
    }
    lines.push("", this.theme.fg("dim", "Supported diagnostics: heartbeat/progress stale · process/tmux missing · worktree/resource/queue · retries/tools/UI/state."));
    return lines;
  }

  private renderMainEvent(event: MainActivityEvent, width: number): string[] {
    const prefix = `${clock(event.at)} ${event.label}`;
    const eventText = compact(event.text, event.kind === "response" ? 800 : 1_200);
    if (event.kind === "reasoning") {
      const text = `${prefix}${eventText ? `  ${eventText}` : ""}`;
      return wrapTextWithAnsi(this.theme.italic(this.theme.fg("thinkingText", text)), width);
    }
    const color = event.state === "error" ? "error" : event.kind === "tool" ? "toolTitle" : event.kind === "response" ? "text" : "muted";
    return wrapTextWithAnsi(this.theme.fg(color, `${prefix}${eventText ? `  ${eventText}` : ""}`), width);
  }

  private renderChildEvent(event: AgentActivity, width: number): string[] {
    const prefix = `${clock(event.at)} ${event.kind}`;
    const eventText = compact(event.text, event.kind === "message" ? 800 : 1_200);
    if (event.kind === "reasoning") return wrapTextWithAnsi(this.theme.italic(this.theme.fg("thinkingText", `${prefix}  ${eventText || "summary streaming"}`)), width);
    const color = event.state === "error" ? "error" : event.kind === "message" ? "text" : event.kind === "tool" ? "toolTitle" : "muted";
    return wrapTextWithAnsi(this.theme.fg(color, `${prefix}  ${eventText}`), width);
  }

  private renderAgentRow(row: AgentRowViewModel, width: number): string {
    const selected = row.id === this.selectedId;
    const prefix = selected ? this.theme.fg("accent", "› ") : "  ";
    const statusColor = row.status === "failed" || row.status === "orphaned" ? "error" : row.completedAssignment || row.status === "paused" ? "warning" : row.status === "running" ? "success" : "muted";
    const content = `${prefix}${this.theme.fg(statusColor, row.icon)} ${row.name}  ${row.currentActivity}  ${this.theme.fg("dim", row.elapsed)}`;
    return truncateToWidth(selected ? this.theme.bg("selectedBg", this.theme.bold(content)) : content, width);
  }

  private keyValues(entries: readonly (readonly [string, string])[], width: number): string[] {
    const labelWidth = width < 64 ? 13 : 17;
    return entries.flatMap(([label, value]) => wrapTextWithAnsi(`${pad(this.theme.fg("muted", label), labelWidth)}  ${value}`, width));
  }

  private sectionTitle(value: string): string {
    return this.theme.fg("accent", this.theme.bold(value));
  }

  private footer(width: number): string {
    const row = this.selected();
    let text = "Tab view · c watchdog · Esc close";
    if (this.view === "delegated" && row?.terminal) text = `↑↓ select${row.latestResult ? " · Enter result" : ""} · h live work · Esc`;
    else if (this.view === "delegated" && row?.completedAssignment) text = "Enter result · a accept · r revise · t take over · e escalate · d dismiss · h history · Esc";
    else if (this.view === "delegated" && row) text = "↑↓ select · s steer · f follow-up · p pause · r recover · o tmux · x abort · d close · Esc";
    return truncateToWidth(this.theme.fg("dim", text), width);
  }

  private selected(): AgentRowViewModel | undefined {
    return this.selectableRows().find((row) => row.id === this.selectedId);
  }

  private selectableRows(): AgentRowViewModel[] {
    return this.viewModel.rows.filter((row) => this.showHistory ? row.terminal : !row.terminal);
  }

  private select(rows: readonly AgentRowViewModel[], index: number): void {
    if (!rows.length) return;
    const bounded = Math.max(0, Math.min(rows.length - 1, index));
    const selectedId = rows[bounded]?.id;
    if (selectedId !== this.selectedId) this.scrollOffset = 0;
    this.selectedId = selectedId;
  }

  private scrollPage(direction: number): void {
    const step = Math.max(1, this.renderedBodyCapacity - 1);
    const maximumOffset = Math.max(0, this.renderedBodyLines - this.renderedBodyCapacity);
    this.scrollOffset = Math.max(0, Math.min(maximumOffset, this.scrollOffset + direction * step));
  }

  private setView(view: ActivityView): void {
    this.view = view;
    this.scrollOffset = 0;
  }

  private cycleView(direction: number): void {
    const index = VIEWS.indexOf(this.view);
    this.setView(VIEWS[(index + direction + VIEWS.length) % VIEWS.length] ?? "overview");
  }

  private paint(line: string, width: number): string {
    return this.theme.bg("customMessageBg", pad(truncateToWidth(line, width), width));
  }
}

function phaseIcon(phase: MainActivityPhase, theme: Theme): string {
  const icon = phase === "ready" ? "○" : phase === "attention" ? "!" : phase === "waiting" || phase === "compacting" || phase === "starting" ? "◌" : "●";
  return `${theme.fg(phaseColor(phase), icon)} `;
}

function phaseColor(phase: MainActivityPhase): "success" | "error" | "warning" | "toolTitle" | "accent" {
  if (phase === "ready") return "success";
  if (phase === "attention") return "error";
  if (phase === "waiting" || phase === "compacting" || phase === "starting") return "warning";
  if (phase === "tool") return "toolTitle";
  return "accent";
}

function titleCase(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function clock(value: string): string {
  return value.length >= 19 ? value.slice(11, 19) : value;
}

function compact(value: string, maximum: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, Math.max(0, maximum - 1))}…`;
}

function formatElapsed(startedAt: string, now: Date): string {
  const total = Math.max(0, Math.floor((now.getTime() - new Date(startedAt).getTime()) / 1_000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

function pad(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}
