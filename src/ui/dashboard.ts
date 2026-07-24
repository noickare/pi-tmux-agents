import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { AgentRowViewModel, DashboardViewModel } from "./view-model.js";

export interface DashboardActions {
  close(): void;
  attach?(agentId: string): void;
  checkNow?(): void;
  steer?(agentId: string): void;
  abort?(agentId: string): void;
}

export class AgentDashboard implements Component {
  private selectedId: string | undefined;

  constructor(private viewModel: DashboardViewModel, private readonly theme: Theme, private readonly actions: DashboardActions) {
    this.selectedId = viewModel.rows[0]?.id;
  }

  setViewModel(viewModel: DashboardViewModel): void {
    this.viewModel = viewModel;
    if (!this.selectedId || !viewModel.rows.some((row) => row.id === this.selectedId)) {
      this.selectedId = viewModel.rows[0]?.id;
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) return this.actions.close();
    if (matchesKey(data, "c")) return this.actions.checkNow?.();
    const index = Math.max(0, this.viewModel.rows.findIndex((row) => row.id === this.selectedId));
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.select(index - 1);
    else if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.select(index + 1);
    else if (matchesKey(data, "o") && this.selectedId) this.actions.attach?.(this.selectedId);
    else if (matchesKey(data, "s") && this.selectedId) this.actions.steer?.(this.selectedId);
    else if (matchesKey(data, "x") && this.selectedId) this.actions.abort?.(this.selectedId);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const lines = safeWidth >= 76 ? this.renderWide(safeWidth) : this.renderNarrow(safeWidth);
    return lines.map((line) => truncateToWidth(line, safeWidth));
  }

  invalidate(): void {}

  private renderWide(width: number): string[] {
    const leftWidth = Math.max(24, Math.min(34, Math.floor(width * 0.36)));
    const gap = 3;
    const rightWidth = Math.max(1, width - leftWidth - gap);
    const header = this.header(width);
    const list = this.renderList(leftWidth);
    const detail = this.renderDetail(rightWidth);
    const rows = Math.max(list.length, detail.length);
    const body: string[] = [];
    for (let i = 0; i < rows; i++) {
      const left = pad(list[i] ?? "", leftWidth);
      body.push(`${left}${" ".repeat(gap)}${detail[i] ?? ""}`);
    }
    return [...header, "", ...body, "", this.help(width)];
  }

  private renderNarrow(width: number): string[] {
    const selected = this.selected();
    return [
      ...this.header(width),
      "",
      ...this.renderList(width),
      ...(selected ? ["", this.theme.fg("muted", "Details"), ...this.renderDetail(width)] : []),
      "",
      this.help(width),
    ];
  }

  private header(width: number): string[] {
    const c = this.viewModel.counts;
    const summary = width < 60
      ? `${c.running} run · ${c.queued} queue · ${c.idle} idle${c.attention > 0 ? ` · !${c.attention}` : ""}`
      : `${c.running} running · ${c.queued} queued · ${c.idle} idle${c.attention > 0 ? ` · ${c.attention} attention` : ""}`;
    const lines = [truncateToWidth(this.theme.fg("accent", this.theme.bold("Agents")) + this.theme.fg("muted", `  ${summary}`), width)];
    if (width < 60) {
      lines.push(truncateToWidth(this.theme.fg("dim", `Parent review ${this.viewModel.parentReviewText}`), width));
      lines.push(truncateToWidth(this.theme.fg("dim", `Watchdog ${this.viewModel.watchdogText}`), width));
    } else {
      lines.push(truncateToWidth(this.theme.fg("dim", `Watchdog ${this.viewModel.watchdogText} · Parent review ${this.viewModel.parentReviewText}`), width));
    }
    return lines;
  }

  private renderList(width: number): string[] {
    if (this.viewModel.rows.length === 0) return [this.theme.fg("muted", "No agents yet."), this.theme.fg("dim", "The parent can spawn predefined or ad-hoc agents.")];
    return this.viewModel.rows.map((row) => {
      const selected = row.id === this.selectedId;
      const prefix = selected ? this.theme.fg("accent", "› ") : "  ";
      const value = `${prefix}${row.icon} ${row.name}  ${row.statusLabel}`;
      return truncateToWidth(selected ? this.theme.bold(value) : value, width);
    });
  }

  private renderDetail(width: number): string[] {
    const row = this.selected();
    if (!row) return [];
    const entries = [
      this.theme.fg("accent", this.theme.bold(row.name)),
      `${row.icon} ${row.statusLabel} · ${row.elapsed}`,
      "",
      this.theme.fg("muted", "Current"),
      row.currentActivity,
      "",
      this.theme.fg("muted", "Task"),
      row.task,
      ...(row.queuedMessages > 0 ? ["", this.theme.fg("muted", "Queue"), `${row.queuedMessages} message(s)`] : []),
      ...(row.worktree ? ["", this.theme.fg("muted", "Worktree"), row.worktree] : []),
      ...(row.tmuxTarget ? ["", this.theme.fg("muted", "tmux"), row.tmuxTarget] : []),
    ];
    return entries.flatMap((entry) => wrapTextWithAnsi(entry, width));
  }

  private help(width: number): string {
    const text = width < 60
      ? "jk nav · s steer · o tmux · esc close"
      : "↑↓/jk navigate · s steer · o tmux · c check · x abort · esc close";
    return truncateToWidth(this.theme.fg("dim", text), width);
  }

  private selected(): AgentRowViewModel | undefined {
    return this.viewModel.rows.find((row) => row.id === this.selectedId);
  }

  private select(index: number): void {
    if (this.viewModel.rows.length === 0) return;
    const bounded = Math.max(0, Math.min(this.viewModel.rows.length - 1, index));
    const row = this.viewModel.rows[bounded];
    if (row) this.selectedId = row.id;
  }
}

function pad(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}
