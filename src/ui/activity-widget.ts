import { keyText, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { MainActivityPhase } from "../core/main-activity.js";
import type { DashboardViewModel } from "./view-model.js";

export class ActivityWidget implements Component {
  constructor(private viewModel: DashboardViewModel, private readonly theme: Theme) {}

  setViewModel(viewModel: DashboardViewModel): void {
    this.viewModel = viewModel;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const rows = this.viewModel.rows.filter((row) => !row.terminal);
    const { counts, main } = this.viewModel;
    const icon = main.phase === "ready" ? "○" : main.phase === "attention" ? "!" : main.phase === "waiting" || main.phase === "compacting" || main.phase === "starting" ? "◌" : "●";
    const mainText = this.theme.fg(phaseColor(main.phase), `${icon} Main ${main.phaseLabel}`);
    const delegated = rows.length === 0
      ? "0 delegated"
      : `${rows.length} delegated · ${counts.running} running · ${counts.queued} queued · ${counts.idle} idle${counts.review ? ` · ${counts.review} ready` : ""}${counts.attention ? ` · ${counts.attention} attention` : ""}`;
    const thinkingKey = displayKey(keyText("app.thinking.toggle") || "ctrl+t");
    const toolsKey = displayKey(keyText("app.tools.expand") || "ctrl+o");
    const help = safeWidth < 76
      ? "Ctrl+Alt+A Activity"
      : `Ctrl+Alt+A Activity · ${thinkingKey} reasoning · ${toolsKey} tools`;
    const separator = this.theme.fg("dim", "  ·  ");
    const line = `${mainText}${separator}${this.theme.fg(counts.attention ? "warning" : "muted", delegated)}${separator}${this.theme.fg("dim", help)}`;
    return [truncateToWidth(line, safeWidth)];
  }

  invalidate(): void {}
}

function displayKey(value: string): string {
  return value.split(/([+/])/).map((part) => /^[a-z]+$/.test(part) ? `${part.slice(0, 1).toUpperCase()}${part.slice(1)}` : part).join("");
}

function phaseColor(phase: MainActivityPhase): "success" | "error" | "warning" | "toolTitle" | "accent" {
  if (phase === "ready") return "success";
  if (phase === "attention") return "error";
  if (phase === "waiting" || phase === "compacting" || phase === "starting") return "warning";
  if (phase === "tool") return "toolTitle";
  return "accent";
}
