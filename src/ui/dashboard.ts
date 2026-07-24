import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { AgentRowViewModel, DashboardViewModel } from "./view-model.js";

export type DashboardView = "overview" | "details" | "queue" | "activity" | "resources" | "diagnostics" | "settings";
const VIEWS: readonly DashboardView[] = ["overview", "details", "queue", "activity", "resources", "diagnostics", "settings"];

export interface DashboardActions {
  close(): void;
  attach?(agentId: string): void;
  checkNow?(): void;
  steer?(agentId: string): void;
  followUp?(agentId: string): void;
  togglePause?(agentId: string, paused: boolean): void;
  recover?(agentId: string): void;
  abort?(agentId: string): void;
  closeAgent?(agentId: string): void;
}

export class AgentDashboard implements Component {
  private selectedId: string | undefined;
  private view: DashboardView = "overview";

  constructor(private viewModel: DashboardViewModel, private readonly theme: Theme, private readonly actions: DashboardActions) {
    this.selectedId = viewModel.rows[0]?.id;
  }

  setViewModel(viewModel: DashboardViewModel): void {
    this.viewModel = viewModel;
    if (!this.selectedId || !viewModel.rows.some((row) => row.id === this.selectedId)) this.selectedId = viewModel.rows[0]?.id;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.view !== "overview") this.view = "overview";
      else this.actions.close();
      return;
    }
    if (matchesKey(data, Key.tab)) { this.cycleView(1); return; }
    if (matchesKey(data, Key.enter) && this.selectedId) { this.view = "details"; return; }
    if (matchesKey(data, "c")) return this.actions.checkNow?.();
    const index = Math.max(0, this.viewModel.rows.findIndex((row) => row.id === this.selectedId));
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.select(index - 1);
    else if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.select(index + 1);
    else if (matchesKey(data, "o") && this.selectedId) this.actions.attach?.(this.selectedId);
    else if (matchesKey(data, "s") && this.selectedId) this.actions.steer?.(this.selectedId);
    else if (matchesKey(data, "f") && this.selectedId) this.actions.followUp?.(this.selectedId);
    else if (matchesKey(data, "p") && this.selectedId) this.actions.togglePause?.(this.selectedId, this.selected()?.status === "paused");
    else if (matchesKey(data, "r") && this.selectedId) this.actions.recover?.(this.selectedId);
    else if (matchesKey(data, "x") && this.selectedId) this.actions.abort?.(this.selectedId);
    else if (matchesKey(data, "d") && this.selectedId) this.actions.closeAgent?.(this.selectedId);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const lines = safeWidth >= 76 ? this.renderWide(safeWidth) : this.renderNarrow(safeWidth);
    return lines.map((line) => this.theme.bg("customMessageBg", pad(truncateToWidth(line, safeWidth), safeWidth)));
  }

  invalidate(): void {}

  private renderWide(width: number): string[] {
    const leftWidth = Math.max(24, Math.min(34, Math.floor(width * 0.36)));
    const gap = 3;
    const rightWidth = Math.max(1, width - leftWidth - gap);
    const list = this.renderList(leftWidth);
    const detail = this.renderView(rightWidth);
    const rows = Math.max(list.length, detail.length);
    const body: string[] = [];
    for (let i = 0; i < rows; i++) body.push(`${pad(list[i] ?? "", leftWidth)}${" ".repeat(gap)}${detail[i] ?? ""}`);
    return [...this.header(width), "", ...body, "", this.help(width)];
  }

  private renderNarrow(width: number): string[] {
    const body = this.view === "overview" ? this.renderList(width) : this.renderView(width);
    return [...this.header(width), "", ...body, "", this.help(width)];
  }

  private header(width: number): string[] {
    const c = this.viewModel.counts;
    const summary = width < 60
      ? `${c.running} run · ${c.queued} queue · ${c.idle} idle${c.attention > 0 ? ` · !${c.attention}` : ""}`
      : `${c.running} running · ${c.queued} queued · ${c.idle} idle${c.attention > 0 ? ` · ${c.attention} attention` : ""}`;
    const title = this.theme.fg("accent", this.theme.bold("Agents")) + this.theme.fg("muted", `  ${summary} · ${this.view}`);
    const timers = width < 60
      ? [
          `Watchdog ${this.viewModel.watchdogText}`,
          `Next watchdog ${this.viewModel.nextWatchdogText}`,
          `Parent review ${this.viewModel.parentReviewText}`,
        ]
      : [`Watchdog ${this.viewModel.watchdogText}; next ${this.viewModel.nextWatchdogText} · Parent review ${this.viewModel.parentReviewText}`];
    return [truncateToWidth(title, width), ...timers.map((line) => truncateToWidth(this.theme.fg("dim", line), width))];
  }

  private renderList(width: number): string[] {
    if (!this.viewModel.rows.length) return [this.theme.fg("muted", "No agents yet."), this.theme.fg("dim", "The parent can spawn predefined or ad-hoc agents.")];
    return this.viewModel.rows.map((row) => {
      const selected = row.id === this.selectedId;
      const prefix = selected ? this.theme.fg("accent", "› ") : "  ";
      const value = `${prefix}${row.icon} ${row.name}  ${row.statusLabel}  ${row.priority}`;
      return truncateToWidth(selected ? this.theme.bold(value) : value, width);
    });
  }

  private renderView(width: number): string[] {
    const row = this.selected();
    if (this.view === "resources") return this.section("Resources", this.viewModel.resourceLines, width);
    if (this.view === "settings") return this.section("Settings", this.viewModel.settingLines, width);
    if (this.view === "diagnostics") {
      const diagnostics = this.viewModel.diagnostics
        .map((item) => `${item.severity === "error" ? "✗" : "!"} ${item.agentId} · ${item.kind}: ${item.message}`);
      return this.section("Diagnostics", diagnostics.length ? diagnostics : ["No current watchdog findings."], width);
    }
    if (!row) return [this.theme.fg("muted", "No selected agent.")];
    if (this.view === "activity") {
      const lines = row.activity.slice().reverse().map((item) => `${item.at.slice(11, 19)} ${item.kind}: ${item.text}`);
      return this.section("Recent activity", lines.length ? lines : ["No recent activity."], width);
    }
    if (this.view === "queue") {
      return this.section("Steering queue", [
        `${row.queuedMessages} queued message(s)`,
        ...row.activity.filter((item) => item.kind === "command").slice(-10).reverse().map((item) => `${item.at.slice(11, 19)} ${item.text}`),
      ], width);
    }
    return this.renderDetails(row, width);
  }

  private renderDetails(row: AgentRowViewModel, width: number): string[] {
    const entries = [
      this.theme.fg("accent", this.theme.bold(row.name)),
      `${row.icon} ${row.statusLabel} · ${row.elapsed} · ${row.priority}/${row.weight}`,
      `Heartbeat ${row.heartbeatAge} · progress ${row.progressAge}`,
      `Stuck threshold ${this.viewModel.stuckThresholdText}`,
      "",
      this.theme.fg("muted", "Current"), row.currentActivity,
      "", this.theme.fg("muted", "Task"), row.task,
      "", this.theme.fg("muted", "Usage"), `${row.usage.inputTokens} in · ${row.usage.outputTokens} out · $${row.usage.cost.toFixed(4)}`,
      ...(row.model ? ["", this.theme.fg("muted", "Model"), row.model] : []),
      ...(row.queuedMessages ? ["", this.theme.fg("muted", "Queue"), `${row.queuedMessages} message(s)`] : []),
      ...(row.worktree ? ["", this.theme.fg("muted", "Worktree"), row.worktree] : []),
      ...(row.branch ? [this.theme.fg("muted", "Branch"), `${row.branch}${row.baseCommit ? ` from ${row.baseCommit.slice(0, 10)}` : ""}`] : []),
      ...(row.tmuxTarget ? [this.theme.fg("muted", "tmux"), row.tmuxTarget] : []),
      ...(row.pendingUiRequest ? ["", this.theme.fg("warning", "Pending extension UI"), row.pendingUiRequest] : []),
      ...(row.replaces ? ["", `Replaces ${row.replaces}`] : []),
      ...(row.replacedBy ? ["", `Replaced by ${row.replacedBy}`] : []),
    ];
    return entries.flatMap((entry) => wrapTextWithAnsi(entry, width));
  }

  private section(title: string, entries: readonly string[], width: number): string[] {
    return [this.theme.fg("accent", this.theme.bold(title)), "", ...entries.flatMap((entry) => wrapTextWithAnsi(entry, width))];
  }

  private help(width: number): string {
    const text = width < 60
      ? "tab view · s/f msg · p pause · r recover · esc"
      : "↑↓/jk · enter details · tab view · s steer · f follow-up · p pause · r recover · o tmux · c check · x abort · d close";
    return truncateToWidth(this.theme.fg("dim", text), width);
  }

  private selected(): AgentRowViewModel | undefined { return this.viewModel.rows.find((row) => row.id === this.selectedId); }

  private select(index: number): void {
    if (!this.viewModel.rows.length) return;
    const bounded = Math.max(0, Math.min(this.viewModel.rows.length - 1, index));
    this.selectedId = this.viewModel.rows[bounded]?.id;
  }

  private cycleView(direction: number): void {
    const index = VIEWS.indexOf(this.view);
    this.view = VIEWS[(index + direction + VIEWS.length) % VIEWS.length] ?? "overview";
  }
}

function pad(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}
