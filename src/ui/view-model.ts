import type { TmuxAgentsConfig } from "../core/config.js";
import type { AgentActivity, AgentPriority, AgentSnapshot, AgentStatus, AgentUsage, AgentWeight } from "../core/protocol.js";
import type { ResourceSnapshot } from "../services/scheduler.js";
import type { WatchdogFinding } from "../services/watchdog.js";

export interface AgentRowViewModel {
  id: string;
  name: string;
  status: AgentStatus;
  statusLabel: string;
  icon: string;
  task: string;
  currentActivity: string;
  elapsed: string;
  heartbeatAge: string;
  progressAge: string;
  queuedMessages: number;
  priority: AgentPriority;
  weight: AgentWeight;
  usage: AgentUsage;
  activity: readonly AgentActivity[];
  worktree?: string;
  branch?: string;
  baseCommit?: string;
  tmuxTarget?: string;
  model?: string;
  statusReason?: string;
  pendingUiRequest?: string;
  replaces?: string;
  replacedBy?: string;
  completedAssignment: boolean;
}

export interface DashboardViewModel {
  rows: readonly AgentRowViewModel[];
  counts: Readonly<Record<"running" | "queued" | "idle" | "review" | "attention", number>>;
  watchdogText: string;
  nextWatchdogText: string;
  parentReviewText: string;
  stuckThresholdText: string;
  diagnostics: readonly WatchdogFinding[];
  resourceLines: readonly string[];
  settingLines: readonly string[];
}

export interface DashboardSupplement {
  findings?: readonly WatchdogFinding[];
  resources?: ResourceSnapshot;
  config?: TmuxAgentsConfig;
}

const STATUS_PRESENTATION: Readonly<Record<AgentStatus, { icon: string; label: string }>> = {
  creating: { icon: "·", label: "Creating" },
  queued: { icon: "◌", label: "Queued" },
  starting: { icon: "↗", label: "Starting" },
  idle: { icon: "○", label: "Idle" },
  running: { icon: "⠋", label: "Running" },
  awaiting_review: { icon: "◆", label: "Awaiting parent review" },
  waiting: { icon: "…", label: "Waiting" },
  retrying: { icon: "↻", label: "Retrying" },
  compacting: { icon: "◇", label: "Compacting" },
  paused: { icon: "Ⅱ", label: "Paused" },
  blocked: { icon: "!", label: "Blocked" },
  aborting: { icon: "×", label: "Aborting" },
  failed: { icon: "✗", label: "Failed" },
  replaced: { icon: "↪", label: "Replaced" },
  closed: { icon: "—", label: "Closed" },
  orphaned: { icon: "?", label: "Orphaned" },
};

export function createDashboardViewModel(
  snapshots: readonly AgentSnapshot[],
  now = new Date(),
  lastWatchdogAt?: Date,
  nextParentReviewOverride?: Date,
  supplement: DashboardSupplement = {},
): DashboardViewModel {
  const rows = snapshots.map((snapshot) => {
    const completedAssignment = snapshot.status === "awaiting_review";
    const basePresentation = STATUS_PRESENTATION[snapshot.status];
    const presentation = snapshot.status === "running" && supplement.config?.animationEnabled === false
      ? { ...basePresentation, icon: "▶" }
      : basePresentation;
    return {
      id: snapshot.agentId,
      name: snapshot.name,
      status: snapshot.status,
      statusLabel: presentation.label,
      icon: presentation.icon,
      task: snapshot.task ?? "No task assigned",
      currentActivity: snapshot.currentTool ?? snapshot.statusReason ?? presentation.label,
      elapsed: formatDuration(now.getTime() - new Date(snapshot.startedAt).getTime()),
      heartbeatAge: `${formatDuration(now.getTime() - new Date(snapshot.lastHeartbeatAt).getTime())} ago`,
      progressAge: `${formatDuration(now.getTime() - new Date(snapshot.lastProgressAt).getTime())} ago`,
      queuedMessages: snapshot.queuedMessages,
      priority: snapshot.priority ?? "normal",
      weight: snapshot.weight ?? (snapshot.worktree ? "heavy" : "light"),
      usage: snapshot.usage,
      activity: snapshot.recentActivity ?? [],
      completedAssignment,
      ...(snapshot.worktree === undefined ? {} : { worktree: snapshot.worktree }),
      ...(snapshot.branch === undefined ? {} : { branch: snapshot.branch }),
      ...(snapshot.baseCommit === undefined ? {} : { baseCommit: snapshot.baseCommit }),
      ...(snapshot.tmuxTarget === undefined ? {} : { tmuxTarget: snapshot.tmuxTarget }),
      ...(snapshot.model === undefined ? {} : { model: snapshot.model }),
      ...(snapshot.statusReason === undefined ? {} : { statusReason: snapshot.statusReason }),
      ...(snapshot.pendingUiRequest === undefined ? {} : { pendingUiRequest: `${snapshot.pendingUiRequest.method} since ${snapshot.pendingUiRequest.createdAt}` }),
      ...(snapshot.replaces === undefined ? {} : { replaces: snapshot.replaces }),
      ...(snapshot.replacedBy === undefined ? {} : { replacedBy: snapshot.replacedBy }),
    } satisfies AgentRowViewModel;
  });

  const nextReview = nextParentReviewOverride?.getTime() ?? snapshots
    .map((item) => item.nextParentReviewAt)
    .filter((value): value is string => value !== undefined)
    .map((value) => new Date(value).getTime())
    .sort((a, b) => a - b)[0];
  const nextWatchdog = lastWatchdogAt && supplement.config
    ? lastWatchdogAt.getTime() + supplement.config.watchdogIntervalMs
    : undefined;

  return {
    rows,
    counts: {
      running: snapshots.filter((item) => ["running", "waiting", "retrying", "compacting"].includes(item.status)).length,
      queued: snapshots.filter((item) => item.status === "queued").length,
      idle: snapshots.filter((item) => item.status === "idle").length,
      review: snapshots.filter((item) => item.status === "awaiting_review").length,
      attention: snapshots.filter((item) => ["blocked", "failed", "orphaned"].includes(item.status)).length,
    },
    watchdogText: lastWatchdogAt ? `checked ${formatDuration(now.getTime() - lastWatchdogAt.getTime())} ago` : "not checked",
    nextWatchdogText: nextWatchdog === undefined ? "not scheduled" : countdown(nextWatchdog, now.getTime()),
    parentReviewText: nextReview === undefined ? "not scheduled" : countdown(nextReview, now.getTime()),
    stuckThresholdText: supplement.config ? formatDuration(supplement.config.progressStaleMs) : "unknown",
    diagnostics: supplement.findings ?? [],
    resourceLines: resourceLines(supplement.resources),
    settingLines: settingLines(supplement.config),
  };
}

export function formatDuration(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
    : `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

function countdown(target: number, now: number): string {
  return target >= now ? `in ${formatDuration(target - now)}` : `overdue by ${formatDuration(now - target)}`;
}

function resourceLines(resources?: ResourceSnapshot): string[] {
  if (!resources) return ["Resource sample pending."];
  return [
    `CPU: ${resources.cpuCount} cores · load ${resources.loadAverage1m.toFixed(2)} · active weight ${resources.activeWeight.toFixed(1)}`,
    `Memory: ${formatBytes(resources.availableMemoryBytes)} available of ${formatBytes(resources.totalMemoryBytes)}`,
    `Disk: ${formatBytes(resources.availableDiskBytes)} available`,
    `Parent reservation: ${resources.parentReservedCpu} CPU · ${formatBytes(resources.parentReservedMemoryBytes)} memory`,
    `Provider backoff: ${resources.providerBackoff ? "active" : "no"}`,
  ];
}

function settingLines(config?: TmuxAgentsConfig): string[] {
  if (!config) return ["Settings unavailable."];
  return [
    `Watchdog: ${formatDuration(config.watchdogIntervalMs)} · stale heartbeat ${formatDuration(config.heartbeatStaleMs)}`,
    `Stuck progress: ${formatDuration(config.progressStaleMs)} · remediation grace ${formatDuration(config.remediationGraceMs)}`,
    `Parent review: ${formatDuration(config.parentReviewIntervalMs)} · idle expiry ${formatDuration(config.idleTimeoutMs)}`,
    `Critical auto-pause: ${config.autoPauseOnCritical ? "on" : "off"} · recovery stable ${formatDuration(config.resourceRecoveryStableMs)}`,
    `Auto-remediation: ${config.autoRemediateStuck ? "on" : "off"}`,
    `Animation: ${config.animationEnabled ? "on" : "off"}`,
    "Edit ~/.pi/agent/tmux-agents.json or trusted .pi/tmux-agents.json, then /reload.",
  ];
}

function formatBytes(value: number): string {
  return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)}GiB` : `${Math.floor(value / 1024 ** 2)}MiB`;
}
