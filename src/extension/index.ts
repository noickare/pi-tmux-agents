import { spawnSync } from "node:child_process";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverAgents } from "../core/agents.js";
import { DEFAULT_CONFIG, loadConfig, type TmuxAgentsConfig } from "../core/config.js";
import { getAgentStateRoot } from "../core/paths.js";
import type { AgentCommandType, AgentPriority, AgentSnapshot, AgentWeight } from "../core/protocol.js";
import type { ResourceSnapshot } from "../services/scheduler.js";
import { AgentRegistry } from "../core/registry.js";
import type { CommandRunner } from "../services/command-runner.js";
import { AgentsDoctor, formatDoctorReport } from "../services/doctor.js";
import { localCommandRunner } from "../services/local-command-runner.js";
import { AgentOrchestrator } from "../services/orchestrator.js";
import { ResourceProbe } from "../services/resource-probe.js";
import { RunnerLauncher } from "../services/runner-launcher.js";
import { SnapshotMonitor } from "../services/snapshot-monitor.js";
import { TmuxService } from "../services/tmux.js";
import { AgentWatchdog, type WatchdogFinding } from "../services/watchdog.js";
import { WorktreeService } from "../services/worktrees.js";
import { AgentDashboard } from "../ui/dashboard.js";
import { ProgressWidget } from "../ui/progress-widget.js";
import { createDashboardViewModel } from "../ui/view-model.js";

const TOOL_ACTIONS = [
  "list", "status", "spawn", "prompt", "steer", "follow_up", "pause", "resume", "abort", "restart", "replace", "set_priority", "diff", "validate", "close", "clean", "check", "merge",
] as const;

const ToolParameters = Type.Object({
  action: StringEnum(TOOL_ACTIONS),
  agent: Type.Optional(Type.String({ description: "Agent id, unique prefix, or exact name" })),
  task: Type.Optional(Type.String({ description: "Task or message for spawn/prompt/steer/follow_up" })),
  role: Type.Optional(Type.String({ description: "Predefined agent role; omit for an ad-hoc agent" })),
  model: Type.Optional(Type.String()),
  tools: Type.Optional(Type.Array(Type.String())),
  mutating: Type.Optional(Type.Boolean({ default: true })),
  approveProject: Type.Optional(Type.Boolean({ default: false })),
  discard: Type.Optional(Type.Boolean({ default: false })),
  reason: Type.Optional(Type.String()),
  priority: Type.Optional(StringEnum(["interactive", "merge-critical", "normal", "speculative"] as const)),
  weight: Type.Optional(StringEnum(["light", "normal", "heavy"] as const)),
  validationCommand: Type.Optional(Type.Array(Type.String(), { description: "Executable followed by argv; no shell interpolation" })),
});

export default function tmuxAgentsExtension(pi: ExtensionAPI) {
  const registry = new AgentRegistry();
  let orchestrator: AgentOrchestrator | undefined;
  let monitor: SnapshotMonitor | undefined;
  let watchdog: AgentWatchdog | undefined;
  let lastWatchdogAt: Date | undefined;
  let nextParentReviewAt: Date | undefined;
  let supervisionTimer: NodeJS.Timeout | undefined;
  let schedulerTimer: NodeJS.Timeout | undefined;
  let watchdogTimer: NodeJS.Timeout | undefined;
  let watchdogRun: Promise<WatchdogFinding[]> | undefined;
  let sessionConfig: TmuxAgentsConfig = DEFAULT_CONFIG;
  let lastWatchdogFindings: WatchdogFinding[] = [];
  let lastResources: ResourceSnapshot | undefined;
  const remediation = new Map<string, { firstSeenAt: number; stage: "diagnosed" | "restarted" | "replaced"; progressAt: string }>();
  let registrySubscription: (() => void) | undefined;
  let clearWidget: (() => void) | undefined;
  const observedCompletions = new Map<string, string>();
  const observedAttention = new Map<string, string>();

  const requireOrchestrator = () => {
    if (!orchestrator) throw new Error("Agent orchestration is not initialized for this session");
    return orchestrator;
  };

  pi.registerTool({
    name: "tmux_agent",
    label: "Tmux Agent",
    description: "Create and control persistent tmux-backed pi agents. Supports replacement handoff, priority, diff, validation, cleanup, supervision, and local branch merges.",
    promptSnippet: "Create, inspect, steer, supervise, and merge persistent tmux-backed subagents",
    promptGuidelines: [
      "Use tmux_agent to delegate independent or specialized work that benefits from persistent context.",
      "Use tmux_agent status/check before assuming a child is stuck, and steer it before replacing it.",
      "Use tmux_agent merge only after validating the child branch.",
    ],
    parameters: ToolParameters,
    async execute(_id, params, _signal, onUpdate, ctx) {
      const manager = requireOrchestrator();
      onUpdate?.({ content: [{ type: "text", text: `${params.action}...` }], details: { action: params.action } });
      if (params.action === "list") return toolResult(formatAgents(manager.list()), { agents: manager.list() });
      if (params.action === "status") {
        const agent = required(params.agent, "agent");
        const snapshot = manager.get(agent) ?? manager.list().find((item) => item.agentId.startsWith(agent) || item.name === agent);
        if (!snapshot) throw new Error(`Unknown agent: ${agent}`);
        return toolResult(formatAgent(snapshot), { agent: snapshot });
      }
      if (params.action === "spawn") {
        const task = required(params.task, "task");
        const role = params.role;
        const discovery = await discoverAgents(ctx.cwd, params.approveProject && ctx.isProjectTrusted() ? "both" : "user");
        const definition = role ? discovery.agents.find((agent) => agent.name === role) : undefined;
        if (role && !definition) throw new Error(`Unknown or untrusted agent role: ${role}`);
        if (definition?.source === "project" && !ctx.isProjectTrusted()) throw new Error("Project agent definitions require a trusted project");
        const launched = await manager.spawn({
          name: role ?? params.agent ?? "worker",
          task,
          cwd: ctx.cwd,
          ...(definition ? { definition } : {}),
          ...(params.model ? { model: params.model } : {}),
          ...(params.tools ? { tools: params.tools } : {}),
          mutating: params.mutating ?? true,
          approveProject: params.approveProject === true && ctx.isProjectTrusted(),
          ...(params.priority ? { priority: params.priority as AgentPriority } : {}),
          ...(params.weight ? { weight: params.weight as AgentWeight } : {}),
        });
        await monitor?.scan();
        const summary = launched.queued
          ? `Queued ${launched.agentId}: ${launched.queueReason}`
          : `Spawned ${launched.agentId}\ntmux: ${launched.tmuxTarget}${launched.worktree ? `\nworktree: ${launched.worktree}` : ""}`;
        return toolResult(summary, { launched });
      }
      if (params.action === "check") {
        const findings = await runWatchdog();
        return toolResult(formatFindings(findings), { findings, agents: manager.list() });
      }
      if (params.action === "merge") {
        await manager.merge(required(params.agent, "agent"), ctx.cwd);
        return toolResult(`Merged ${params.agent} into the parent branch`, { agents: manager.list() });
      }
      if (params.action === "clean") {
        if (params.agent) {
          await manager.closeAndClean(params.agent, ctx.cwd, params.discard ?? false);
          return toolResult(`Cleaned ${params.agent}`, { agents: manager.list() });
        }
        const cleaned = await manager.clean(ctx.cwd, params.discard ?? false);
        return toolResult(`Cleaned: ${cleaned.cleaned.join(", ") || "none"}${cleaned.retained.length ? `\nRetained:\n${cleaned.retained.map((item) => `${item.agentId}: ${item.reason}`).join("\n")}` : ""}`, { cleaned });
      }
      const agent = required(params.agent, "agent");
      if (params.action === "replace") {
        const launched = await manager.replace(agent, params.reason);
        await monitor?.scan();
        return toolResult(`Replaced ${agent} with ${launched.agentId}${launched.queued ? ` (queued: ${launched.queueReason})` : `\ntmux: ${launched.tmuxTarget}`}`, { launched });
      }
      if (params.action === "set_priority") {
        await manager.setPriority(agent, required(params.priority, "priority") as AgentPriority);
        return toolResult(`Priority for ${agent} set to ${params.priority}`, { agents: manager.list() });
      }
      if (params.action === "diff") {
        const diff = await manager.diff(agent);
        return toolResult(diff || "No changes from the agent base commit.", { diff });
      }
      if (params.action === "validate") {
        if (!params.validationCommand?.length) throw new Error("validationCommand is required");
        const validation = await manager.validate(agent, params.validationCommand);
        return toolResult(`Exit ${validation.code}\n${validation.stdout}${validation.stderr ? `\nSTDERR:\n${validation.stderr}` : ""}`, { validation });
      }
      if (params.action === "close") {
        await manager.closeAndClean(agent, ctx.cwd, params.discard ?? false);
        return toolResult(`Close queued for ${agent}`, { agents: manager.list() });
      }
      const type = params.action as AgentCommandType;
      const message = ["prompt", "steer", "follow_up"].includes(type) ? required(params.task, "task") : undefined;
      const commandId = await manager.command(agent, type, message);
      return toolResult(`${type} queued for ${agent} (${commandId})`, { commandId, agents: manager.list() });
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("tmux_agent ")) + theme.fg("accent", args.action) + (args.agent ? theme.fg("muted", ` ${args.agent}`) : ""), 0, 0);
    },
    renderResult(result, { expanded }, theme, context) {
      const text = result.content.find((item) => item.type === "text");
      const value = text?.type === "text" ? text.text : "";
      return new Text(theme.fg(context.isError ? "error" : "toolOutput", expanded ? value : value.split("\n").slice(0, 6).join("\n")), 0, 0);
    },
  });

  pi.registerMessageRenderer("tmux-agents-supervision", (message, _options, theme) => {
    const content = typeof message.content === "string"
      ? message.content
      : message.content.filter((item) => item.type === "text").map((item) => item.type === "text" ? item.text : "").join("\n");
    return new Text(theme.fg("warning", theme.bold("Agent supervision\n")) + theme.fg("muted", content), 0, 0);
  });

  pi.registerCommand("agents", {
    description: "Open dashboard, or use: /agents new|check|attach|steer|follow-up|replace|diff|validate|clean",
    handler: async (args, ctx) => {
      const [action, agentId, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (action === "doctor") return runDoctor(ctx);
      if (action === "setup") return runSetup(ctx);
      if (action === "check") {
        const findings = await runWatchdog();
        ctx.ui.notify(formatFindings(findings), findings.some((item) => item.severity === "error") ? "error" : "info");
        return;
      }
      if (action === "attach" && agentId) return attachAgent(ctx, requireAgent(agentId));
      if (action === "clean") {
        if (!await ctx.ui.confirm("Clean terminal agents?", "Clean worktrees are removed; dirty worktrees are retained.")) return;
        const result = await requireOrchestrator().clean(ctx.cwd, [agentId, ...rest].includes("--discard"));
        ctx.ui.notify(`Cleaned ${result.cleaned.length}; retained ${result.retained.length}`, result.retained.length ? "warning" : "info");
        return;
      }
      if (action === "diff" && agentId) {
        await ctx.ui.editor(`Diff ${agentId}`, await requireOrchestrator().diff(agentId) || "No changes from base commit.");
        return;
      }
      if (action === "validate" && agentId) {
        if (!rest.length) { ctx.ui.notify("Usage: /agents validate <agent> <executable> [args...]", "error"); return; }
        const result = await requireOrchestrator().validate(agentId, rest);
        ctx.ui.notify(`Validation exited ${result.code}`, result.code === 0 ? "info" : "error");
        await ctx.ui.editor(`Validation ${agentId}`, `${result.stdout}${result.stderr ? `\nSTDERR:\n${result.stderr}` : ""}`);
        return;
      }
      if (action === "replace" && agentId) {
        if (!await ctx.ui.confirm(`Replace ${agentId}?`, "A new persistent session will inherit its worktree and receive a context handoff.")) return;
        const launched = await requireOrchestrator().replace(agentId, rest.join(" ") || "Replaced by operator");
        ctx.ui.notify(`Replacement ${launched.agentId} ${launched.queued ? "queued" : "started"}`, "info");
        return;
      }
      if (["follow-up", "follow_up"].includes(action ?? "") && agentId) {
        const message = rest.join(" ") || await ctx.ui.editor(`Follow up ${agentId}`, "");
        if (message) await requireOrchestrator().command(agentId, "follow_up", message);
        return;
      }
      if (action === "steer" && agentId) {
        const message = rest.join(" ") || await ctx.ui.input(`Steer ${agentId}`, "Instruction");
        if (message) await requireOrchestrator().command(agentId, "steer", message);
        return;
      }
      if (action === "new") {
        const task = parseNewAgentTask(agentId, rest) || await ctx.ui.input("New persistent agent", "Task");
        if (!task) return;
        const launched = await requireOrchestrator().spawn({ name: "worker", task, cwd: ctx.cwd, mutating: true, approveProject: ctx.isProjectTrusted() });
        ctx.ui.notify(`Spawned ${launched.agentId}`, "info");
        return;
      }
      await showDashboard(ctx);
    },
  });

  pi.registerCommand("agents-doctor", {
    description: "Check prerequisites and tmux configuration",
    handler: async (_args, ctx) => runDoctor(ctx),
  });

  pi.registerCommand("agents-setup", {
    description: "Show setup guidance without running sudo or editing configuration",
    handler: async (_args, ctx) => runSetup(ctx),
  });

  pi.on("session_start", async (_event, ctx) => {
    const parentSessionId = ctx.sessionManager.getSessionId();
    const agentDir = getAgentDir();
    sessionConfig = await loadConfig(ctx.cwd, agentDir, ctx.isProjectTrusted());
    const run: CommandRunner = async (command, args, options) => pi.exec(command, [...args], options);
    const tmux = new TmuxService(run);
    const resourceProbe = new ResourceProbe(run);
    const worktrees = new WorktreeService(run);
    const schedulerThresholds = {
      minimumFreeMemoryBytes: sessionConfig.minimumFreeMemoryBytes,
      criticalFreeMemoryBytes: sessionConfig.criticalFreeMemoryBytes,
      minimumFreeDiskBytes: sessionConfig.minimumFreeDiskBytes,
      maximumLoadPerAvailableCpu: sessionConfig.maximumLoadPerAvailableCpu,
    };
    orchestrator = new AgentOrchestrator(
      parentSessionId,
      agentDir,
      registry,
      new RunnerLauncher(tmux),
      worktrees,
      {
        resourceProbe,
        resourceProbeOptions: {
          parentReservedCpu: sessionConfig.parentReservedCpu,
          parentReservedMemoryBytes: sessionConfig.parentReservedMemoryBytes,
        },
        schedulerThresholds,
        resourceRecoveryStableMs: sessionConfig.resourceRecoveryStableMs,
      },
    );
    monitor = new SnapshotMonitor(getAgentStateRoot(parentSessionId, agentDir), registry, {
      intervalMs: sessionConfig.monitorIntervalMs,
      onError: (error) => ctx.ui.notify(`Agent monitor: ${error.message}`, "error"),
    });
    watchdog = new AgentWatchdog(monitor, tmux, {
      heartbeatStaleMs: sessionConfig.heartbeatStaleMs,
      progressStaleMs: sessionConfig.progressStaleMs,
      uiRequestStaleMs: sessionConfig.uiRequestStaleMs,
      queueStaleMs: sessionConfig.queueStaleMs,
      resourceProbe,
      worktrees,
      queue: { health: () => requireOrchestrator().queueHealth() },
      schedulerThresholds,
    });
    await monitor.start();
    lastWatchdogAt = new Date();
    nextParentReviewAt = new Date(Date.now() + sessionConfig.parentReviewIntervalMs);

    for (const agent of registry.list()) if (agent.lastCompletedAt) observedCompletions.set(agent.agentId, agent.lastCompletedAt);
    registrySubscription = registry.subscribe(() => {
      updateStatus(ctx);
      for (const agent of registry.list()) {
        if (agent.lastCompletedAt && observedCompletions.get(agent.agentId) !== agent.lastCompletedAt) {
          observedCompletions.set(agent.agentId, agent.lastCompletedAt);
          wakeParent(`Agent ${agent.name} completed its assignment and is idle. Inspect its output and branch, then decide whether to validate, request fixes, merge, or reassign it.`);
        }
        if (["failed", "blocked", "orphaned"].includes(agent.status)) {
          const attentionKey = `${agent.status}:${agent.statusReason ?? ""}`;
          if (observedAttention.get(agent.agentId) !== attentionKey) {
            observedAttention.set(agent.agentId, attentionKey);
            wakeParent(`Agent ${agent.name} requires attention: ${agent.statusReason ?? agent.status}.`);
          }
        } else {
          observedAttention.delete(agent.agentId);
        }
      }
    });

    supervisionTimer = setInterval(() => void supervise(), 10_000);
    watchdogTimer = setInterval(() => void runWatchdog().catch((error: unknown) => ctx.ui.notify(`Agent watchdog: ${(error as Error).message}`, "error")), sessionConfig.watchdogIntervalMs);
    schedulerTimer = setInterval(() => void (async () => {
      if (!orchestrator) return;
      if (sessionConfig.autoPauseOnCritical) {
        const balance = await orchestrator.rebalance(ctx.cwd);
        lastResources = balance?.resources;
        if (balance?.paused.length) wakeParent(`Critical resource pressure auto-paused: ${balance.paused.join(", ")}`);
        if (balance?.resumed.length) wakeParent(`Resources recovered; resumed: ${balance.resumed.join(", ")}`);
      } else lastResources = await orchestrator.resources(ctx.cwd);
      const count = await orchestrator.drainQueue();
      if (count) await monitor?.scan();
    })().catch((error: unknown) => ctx.ui.notify(`Agent scheduler: ${(error as Error).message}`, "error")), sessionConfig.schedulerIntervalMs);
    if (ctx.mode === "tui") installWidget(ctx);
    updateStatus(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    monitor?.stop();
    monitor = undefined;
    watchdog = undefined;
    watchdogRun = undefined;
    orchestrator = undefined;
    lastWatchdogFindings = [];
    lastResources = undefined;
    remediation.clear();
    registrySubscription?.();
    registrySubscription = undefined;
    clearWidget?.();
    clearWidget = undefined;
    if (supervisionTimer) clearInterval(supervisionTimer);
    supervisionTimer = undefined;
    if (schedulerTimer) clearInterval(schedulerTimer);
    schedulerTimer = undefined;
    if (watchdogTimer) clearInterval(watchdogTimer);
    watchdogTimer = undefined;
    ctx.ui.setWidget("tmux-agents", undefined);
    ctx.ui.setStatus("tmux-agents", undefined);
  });

  async function showDashboard(ctx: ExtensionCommandContext): Promise<void> {
    if (ctx.mode !== "tui") { ctx.ui.notify("The agents dashboard requires TUI mode", "error"); return; }
    let liveTerminalWidth = process.stdout.columns || 80;
    await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
      liveTerminalWidth = tui.terminal.columns;
      const build = () => createDashboardViewModel(registry.list(), new Date(), lastWatchdogAt, nextParentReviewAt, {
        findings: lastWatchdogFindings,
        ...(lastResources ? { resources: lastResources } : {}),
        config: sessionConfig,
      });
      const safely = (operation: () => Promise<unknown>) => {
        void operation().catch((error: unknown) => ctx.ui.notify(`Agent action failed: ${(error as Error).message}`, "error"));
      };
      const dashboard = new AgentDashboard(build(), theme, {
        close: () => done(),
        checkNow: () => safely(async () => { await runWatchdog(); dashboard.setViewModel(build()); tui.requestRender(); }),
        attach: (id) => { done(); safely(() => attachAgent(ctx, requireAgent(id))); },
        steer: (id) => safely(() => steerFromDashboard(ctx, id)),
        followUp: (id) => safely(() => followUpFromDashboard(ctx, id)),
        togglePause: (id, paused) => safely(() => requireOrchestrator().command(id, paused ? "resume" : "pause")),
        recover: (id) => safely(() => recoverFromDashboard(ctx, id)),
        abort: (id) => safely(() => abortFromDashboard(ctx, id)),
        closeAgent: (id) => safely(() => closeFromDashboard(ctx, id)),
      });
      const refresh = () => { liveTerminalWidth = tui.terminal.columns; dashboard.setViewModel(build()); tui.requestRender(); };
      const unsubscribe = registry.subscribe(refresh);
      const timer = setInterval(refresh, 1_000);
      return { render: (width) => dashboard.render(width), handleInput: (data) => { dashboard.handleInput(data); tui.requestRender(); }, invalidate: () => dashboard.invalidate(), dispose: () => { clearInterval(timer); unsubscribe(); } };
    }, { overlay: true, overlayOptions: () => ({
      width: liveTerminalWidth < 60 ? "100%" : liveTerminalWidth >= 110 ? "68%" : "94%",
      maxHeight: liveTerminalWidth < 60 ? "100%" : "88%",
      anchor: liveTerminalWidth >= 110 ? "right-center" : "center",
      margin: liveTerminalWidth < 60 ? 0 : 1,
    }) });
  }

  function installWidget(ctx: ExtensionContext): void {
    ctx.ui.setWidget("tmux-agents", (tui: TUI, theme) => {
      const build = () => createDashboardViewModel(registry.list(), new Date(), lastWatchdogAt, nextParentReviewAt, {
        findings: lastWatchdogFindings,
        ...(lastResources ? { resources: lastResources } : {}),
        config: sessionConfig,
      });
      const widget = new ProgressWidget(build(), theme);
      const refresh = () => { widget.setViewModel(build()); tui.requestRender(); };
      const unsubscribe = registry.subscribe(refresh);
      const timer = setInterval(refresh, 1_000);
      const dispose = () => { clearInterval(timer); unsubscribe(); };
      clearWidget = dispose;
      return Object.assign(widget, { dispose });
    });
  }

  async function runWatchdog(): Promise<WatchdogFinding[]> {
    if (watchdogRun) return watchdogRun;
    watchdogRun = runWatchdogOnce().finally(() => { watchdogRun = undefined; });
    return watchdogRun;
  }

  async function runWatchdogOnce(): Promise<WatchdogFinding[]> {
    if (!watchdog) throw new Error("Watchdog is not initialized");
    const findings = await watchdog.check();
    lastWatchdogAt = new Date();
    lastWatchdogFindings = findings;
    if (sessionConfig.autoRemediateStuck) await remediate(findings);
    if (findings.length) wakeParent(`Watchdog findings:\n${formatFindings(findings)}\nInspect and remediate affected children.`);
    return findings;
  }

  async function remediate(findings: readonly WatchdogFinding[]): Promise<void> {
    const manager = requireOrchestrator();
    const actionableKinds = new Set<WatchdogFinding["kind"]>(["progress_stale", "heartbeat_stale", "process_missing", "tmux_missing", "retries_repeated", "tool_failures"]);
    const grouped = new Map<string, WatchdogFinding[]>();
    for (const finding of findings) {
      if (!actionableKinds.has(finding.kind) || finding.agentId === "queue") continue;
      grouped.set(finding.agentId, [...(grouped.get(finding.agentId) ?? []), finding]);
    }
    for (const agentId of [...remediation.keys()]) if (!grouped.has(agentId)) remediation.delete(agentId);
    for (const [agentId, agentFindings] of grouped) {
      const snapshot = manager.get(agentId);
      if (!snapshot || ["closed", "replaced"].includes(snapshot.status)) continue;
      const existing = remediation.get(agentId);
      if (!existing || existing.progressAt !== snapshot.lastProgressAt) {
        const canSteer = !agentFindings.some((finding) => ["heartbeat_stale", "process_missing", "tmux_missing"].includes(finding.kind));
        if (canSteer) {
          await manager.command(agentId, "steer", `Supervisor diagnostic: progress appears stuck (${agentFindings.map((item) => item.message).join("; ")}). Report your current blocker, preserve partial work, and proceed with the smallest concrete next step.`);
        }
        remediation.set(agentId, { firstSeenAt: Date.now(), stage: "diagnosed", progressAt: snapshot.lastProgressAt });
        continue;
      }
      const elapsed = Date.now() - existing.firstSeenAt;
      if (existing.stage === "diagnosed" && elapsed >= sessionConfig.remediationGraceMs) {
        if (agentFindings.some((finding) => ["heartbeat_stale", "process_missing", "tmux_missing"].includes(finding.kind))) {
          const replacement = await manager.replace(agentId, `Watchdog recovery after ${agentFindings.map((item) => item.kind).join(", ")}`);
          remediation.set(agentId, { ...existing, stage: "replaced" });
          wakeParent(`Watchdog replaced ${agentId} with ${replacement.agentId}.`);
        } else {
          await manager.command(agentId, "restart");
          remediation.set(agentId, { ...existing, stage: "restarted" });
          wakeParent(`Watchdog restarted ${agentId} after the diagnostic grace period.`);
        }
      } else if (existing.stage === "restarted" && elapsed >= sessionConfig.remediationGraceMs * 2) {
        const replacement = await manager.replace(agentId, "No progress after watchdog diagnostic and RPC restart");
        remediation.set(agentId, { ...existing, stage: "replaced" });
        wakeParent(`Watchdog replaced ${agentId} with ${replacement.agentId} after restart did not recover progress.`);
      }
    }
  }

  async function supervise(): Promise<void> {
    if (!nextParentReviewAt || Date.now() < nextParentReviewAt.getTime()) return;
    const active = registry.list().filter((agent) => !["closed", "replaced"].includes(agent.status));
    nextParentReviewAt = new Date(Date.now() + sessionConfig.parentReviewIntervalMs);
    for (const agent of active) {
      if (agent.status !== "idle") continue;
      const idleSince = new Date(agent.lastCompletedAt ?? agent.updatedAt).getTime();
      if (Date.now() - idleSince > sessionConfig.idleTimeoutMs) await orchestrator?.command(agent.agentId, "close");
    }
    if (!active.length) return;
    const findings = await runWatchdog().catch(() => []);
    wakeParent(`Periodic child review:\n${formatAgents(active)}${findings.length ? `\n\n${formatFindings(findings)}` : ""}\nCheck for stalled work, steer as needed, validate completed branches, and merge or reassign work.`);
  }

  async function runDoctor(ctx: ExtensionContext): Promise<void> {
    const checks = await doctor().check(getAgentStateRoot(ctx.sessionManager.getSessionId(), getAgentDir()));
    const report = formatDoctorReport(checks);
    ctx.ui.notify(report, checks.some((check) => !check.ok) ? "warning" : "info");
  }

  async function runSetup(ctx: ExtensionContext): Promise<void> {
    const checks = await doctor().check(getAgentStateRoot(ctx.sessionManager.getSessionId(), getAgentDir()));
    const report = formatDoctorReport(checks);
    if (checks.every((check) => check.ok)) { ctx.ui.notify("Persistent agent prerequisites are ready.", "info"); return; }
    if (ctx.hasUI && await ctx.ui.confirm("Show setup guidance?", "No commands will be executed and no files will be changed.")) {
      await ctx.ui.editor("Persistent agent setup", `${report}\n\nAfter applying desired changes, run /agents-doctor again.`);
    }
  }

  function doctor(): AgentsDoctor {
    const run: CommandRunner = async (command, args, options) => pi.exec(command, [...args], options);
    return new AgentsDoctor(run);
  }

  function wakeParent(content: string): void {
    pi.sendMessage({ customType: "tmux-agents-supervision", content, display: true }, { deliverAs: "followUp", triggerTurn: true });
  }

  function updateStatus(ctx: ExtensionContext): void {
    const agents = registry.list();
    const active = agents.filter((agent) => ["running", "waiting", "retrying", "compacting"].includes(agent.status)).length;
    const attention = agents.filter((agent) => ["failed", "blocked", "orphaned"].includes(agent.status)).length;
    ctx.ui.setStatus("tmux-agents", ctx.ui.theme.fg(attention ? "warning" : active ? "accent" : "dim", `agents: ${active} active${attention ? ` · ${attention}!` : ""}`));
  }

  function requireAgent(id: string): AgentSnapshot {
    const exact = registry.get(id);
    const matches = exact ? [exact] : registry.list().filter((agent) => agent.agentId.startsWith(id) || agent.name === id);
    if (matches.length !== 1) throw new Error(matches.length ? `Ambiguous agent: ${id}` : `Unknown agent: ${id}`);
    return matches[0]!;
  }

  async function steerFromDashboard(ctx: ExtensionCommandContext, id: string): Promise<void> {
    const message = await ctx.ui.editor(`Steer ${id} now`, "");
    if (message) await requireOrchestrator().command(id, "steer", message);
  }

  async function followUpFromDashboard(ctx: ExtensionCommandContext, id: string): Promise<void> {
    const message = await ctx.ui.editor(`Follow up after ${id}'s current work`, "");
    if (message) await requireOrchestrator().command(id, "follow_up", message);
  }

  async function recoverFromDashboard(ctx: ExtensionCommandContext, id: string): Promise<void> {
    const action = await ctx.ui.select(`Recover ${id}`, ["Restart RPC session", "Replace agent with worktree handoff"]);
    if (action === "Restart RPC session") await requireOrchestrator().command(id, "restart");
    if (action === "Replace agent with worktree handoff") await requireOrchestrator().replace(id, "Replacement requested from dashboard");
  }

  async function closeFromDashboard(ctx: ExtensionCommandContext, id: string): Promise<void> {
    if (await ctx.ui.confirm(`Close and clean ${id}?`, "Dirty worktrees are retained.")) await requireOrchestrator().closeAndClean(id, ctx.cwd);
  }

  async function abortFromDashboard(ctx: ExtensionCommandContext, id: string): Promise<void> {
    if (await ctx.ui.confirm(`Abort ${id}?`, "The persistent agent will remain available after its current operation is aborted.")) await requireOrchestrator().command(id, "abort");
  }

  async function attachAgent(ctx: ExtensionCommandContext, snapshot: AgentSnapshot): Promise<void> {
    if (!snapshot.tmuxTarget) throw new Error(`Agent ${snapshot.name} has no tmux target`);
    const [session] = snapshot.tmuxTarget.split(":");
    if (process.env.TMUX) {
      await pi.exec("tmux", ["select-window", "-t", snapshot.tmuxTarget]);
      await pi.exec("tmux", ["switch-client", "-t", session!]);
      return;
    }
    await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
      tui.stop();
      spawnSync("tmux", ["attach-session", "-t", snapshot.tmuxTarget!], { stdio: "inherit", shell: false });
      tui.start();
      tui.requestRender(true);
      done();
      return { render: () => [], invalidate() {} };
    });
  }
}

export function parseNewAgentTask(firstWord: string | undefined, remaining: readonly string[]): string {
  return [firstWord, ...remaining].filter((part): part is string => Boolean(part)).join(" ");
}

function toolResult(text: string, details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}
function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}
function formatAgent(agent: AgentSnapshot): string {
  return `${agent.agentId} [${agent.status}] · ${agent.priority ?? "normal"}/${agent.weight ?? (agent.worktree ? "heavy" : "light")}` +
    `${agent.task ? `\nTask: ${agent.task}` : ""}${agent.currentTool ? `\nCurrent: ${agent.currentTool}` : ""}` +
    `\nHeartbeat: ${agent.lastHeartbeatAt}\nProgress: ${agent.lastProgressAt}\nQueue: ${agent.queuedMessages}` +
    `\nUsage: ${agent.usage.inputTokens} in · ${agent.usage.outputTokens} out · $${agent.usage.cost.toFixed(4)}` +
    `${agent.worktree ? `\nWorktree: ${agent.worktree}` : ""}${agent.branch ? `\nBranch: ${agent.branch}${agent.baseCommit ? ` from ${agent.baseCommit}` : ""}` : ""}` +
    `${agent.tmuxTarget ? `\ntmux: ${agent.tmuxTarget}` : ""}${agent.replaces ? `\nReplaces: ${agent.replaces}` : ""}${agent.replacedBy ? `\nReplaced by: ${agent.replacedBy}` : ""}`;
}
function formatAgents(agents: readonly AgentSnapshot[]): string {
  return agents.length ? agents.map((agent) => `${agent.agentId} [${agent.status}] ${agent.currentTool ?? agent.task ?? "idle"}`).join("\n") : "No persistent agents.";
}
function formatFindings(findings: readonly WatchdogFinding[]): string {
  return findings.length ? findings.map((finding) => `${finding.severity === "error" ? "✗" : "!"} ${finding.agentId}: ${finding.message}`).join("\n") : "Watchdog healthy.";
}
