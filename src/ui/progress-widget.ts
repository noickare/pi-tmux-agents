import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { DashboardViewModel } from "./view-model.js";

export class ProgressWidget implements Component {
  constructor(private viewModel: DashboardViewModel, private readonly theme: Theme) {}

  setViewModel(viewModel: DashboardViewModel): void {
    this.viewModel = viewModel;
  }

  render(width: number): string[] {
    if (this.viewModel.rows.length === 0) return [];
    const { counts } = this.viewModel;
    const summary = width < 60
      ? `Agents ${counts.running} run · ${counts.queued} queue · ${counts.idle} idle${counts.attention > 0 ? ` · !${counts.attention}` : ""}`
      : `Agents  ${counts.running} running · ${counts.queued} queued · ${counts.idle} idle${counts.attention > 0 ? ` · ${counts.attention} need attention` : ""}`;
    const lines = [this.theme.fg(counts.attention > 0 ? "warning" : "accent", summary)];

    for (const row of this.viewModel.rows.slice(0, 3)) {
      const color = row.status === "failed" || row.status === "orphaned" ? "error"
        : row.status === "completed" ? "success"
        : row.status === "blocked" || row.status === "paused" ? "warning" : "text";
      lines.push(`${this.theme.fg(color, `${row.icon} ${row.name}`)}  ${this.theme.fg("dim", row.currentActivity)}  ${this.theme.fg("muted", row.elapsed)}`);
    }

    const supervision = width < 60
      ? `Review ${this.viewModel.parentReviewText} · WD ${this.viewModel.watchdogText.replace("checked ", "")}`
      : `Parent review ${this.viewModel.parentReviewText} · watchdog ${this.viewModel.watchdogText}`;
    lines.push(this.theme.fg("dim", supervision));
    return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
  }

  invalidate(): void {}
}
