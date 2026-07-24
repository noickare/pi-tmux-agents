import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AgentRegistry } from "../core/registry.js";
import { AgentDashboard } from "../ui/dashboard.js";
import { ProgressWidget } from "../ui/progress-widget.js";
import { createDashboardViewModel } from "../ui/view-model.js";

export default function tmuxAgentsExtension(pi: ExtensionAPI) {
  const registry = new AgentRegistry();
  let lastWatchdogAt: Date | undefined;
  let clearWidget: (() => void) | undefined;

  pi.registerCommand("agents", {
    description: "Open the persistent agent dashboard",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("The agents dashboard requires TUI mode", "error");
        return;
      }

      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        const build = () => createDashboardViewModel(registry.list(), new Date(), lastWatchdogAt);
        const dashboard = new AgentDashboard(build(), theme, {
          close: () => done(),
          checkNow: () => {
            lastWatchdogAt = new Date();
            dashboard.setViewModel(build());
            tui.requestRender();
          },
        });
        const unsubscribe = registry.subscribe(() => {
          dashboard.setViewModel(build());
          tui.requestRender();
        });
        return {
          render: (width) => dashboard.render(width),
          handleInput: (data) => { dashboard.handleInput(data); tui.requestRender(); },
          invalidate: () => dashboard.invalidate(),
          dispose: unsubscribe,
        };
      }, {
        overlay: true,
        overlayOptions: () => ({
          width: process.stdout.columns >= 110 ? "68%" : "94%",
          maxHeight: "88%",
          anchor: process.stdout.columns >= 110 ? "right-center" : "center",
          margin: 1,
        }),
      });
    },
  });

  pi.registerCommand("agents-doctor", {
    description: "Check the local prerequisites for persistent tmux agents",
    handler: async (_args, ctx) => {
      const [tmux, git] = await Promise.all([
        pi.exec("tmux", ["-V"]),
        pi.exec("git", ["--version"]),
      ]);
      lastWatchdogAt = new Date();
      const failures = [tmux.code === 0 ? undefined : "tmux", git.code === 0 ? undefined : "git"].filter(Boolean);
      if (failures.length > 0) ctx.ui.notify(`Missing prerequisites: ${failures.join(", ")}`, "error");
      else ctx.ui.notify(`${tmux.stdout.trim()} · ${git.stdout.trim()} · foundation healthy`, "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    const factory = (tui: Parameters<NonNullable<Parameters<typeof ctx.ui.setWidget>[1]>>[0], theme: Parameters<NonNullable<Parameters<typeof ctx.ui.setWidget>[1]>>[1]) => {
      const widget = new ProgressWidget(createDashboardViewModel(registry.list(), new Date(), lastWatchdogAt), theme);
      const unsubscribe = registry.subscribe(() => {
        widget.setViewModel(createDashboardViewModel(registry.list(), new Date(), lastWatchdogAt));
        tui.requestRender();
      });
      clearWidget = unsubscribe;
      return Object.assign(widget, { dispose: unsubscribe });
    };
    ctx.ui.setWidget("tmux-agents", factory);
    ctx.ui.setStatus("tmux-agents", ctx.ui.theme.fg("dim", "agents: ready"));
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearWidget?.();
    clearWidget = undefined;
    ctx.ui.setWidget("tmux-agents", undefined);
    ctx.ui.setStatus("tmux-agents", undefined);
  });
}
