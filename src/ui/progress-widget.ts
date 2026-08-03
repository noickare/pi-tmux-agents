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
    const visibleRows = this.viewModel.rows.filter((row) => !["closed", "replaced"].includes(row.status));
    if (visibleRows.length === 0) return [];
    const { counts } = this.viewModel;
    const summary = width < 60
      ? `Agents ${counts.running} run · ${counts.queued} queue · ${counts.idle} idle${counts.review > 0 ? ` · ◆${counts.review}` : ""}${counts.attention > 0 ? ` · !${counts.attention}` : ""}`
      : `Agents  ${counts.running} running · ${counts.queued} queued · ${counts.idle} idle${counts.review > 0 ? ` · ${counts.review} awaiting parent review` : ""}${counts.attention > 0 ? ` · ${counts.attention} need parent attention` : ""}`;
    const lines = [this.theme.fg(counts.attention > 0 ? "warning" : "accent", summary)];

    for (const row of visibleRows.slice(0, 3)) {
      const color = row.status === "failed" || row.status === "orphaned" ? "error"
        : row.completedAssignment ? "accent"
        : row.status === "blocked" || row.status === "paused" ? "warning" : "text";
      lines.push(`${this.theme.fg(color, `${row.icon} ${row.name}`)}  ${this.theme.fg("dim", row.currentActivity)}  ${this.theme.fg("muted", row.elapsed)}`);
    }

    const supervision = counts.review > 0
      ? width < 60
        ? `Result delivered · WD ${this.viewModel.watchdogText.replace("checked ", "")}`
        : `${counts.review === 1 ? "Result" : "Results"} delivered to parent · watchdog ${this.viewModel.watchdogText}`
      : width < 60
        ? `Review ${this.viewModel.parentReviewText} · WD ${this.viewModel.watchdogText.replace("checked ", "")}`
        : `Parent review ${this.viewModel.parentReviewText} · watchdog ${this.viewModel.watchdogText}`;
    lines.push(this.theme.fg("dim", supervision));
    return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
  }

  invalidate(): void {}
}
