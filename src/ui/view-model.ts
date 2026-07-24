import type { AgentSnapshot, AgentStatus } from "../core/protocol.js";

export interface AgentRowViewModel {
  id: string;
  name: string;
  status: AgentStatus;
  statusLabel: string;
  icon: string;
  task: string;
  currentActivity: string;
  elapsed: string;
  queuedMessages: number;
  worktree?: string;
  branch?: string;
  tmuxTarget?: string;
  statusReason?: string;
}

export interface DashboardViewModel {
  rows: readonly AgentRowViewModel[];
  counts: Readonly<Record<"running" | "queued" | "idle" | "attention", number>>;
  watchdogText: string;
  parentReviewText: string;
}

const STATUS_PRESENTATION: Readonly<Record<AgentStatus, { icon: string; label: string }>> = {
  creating: { icon: "·", label: "Creating" },
  queued: { icon: "◌", label: "Queued" },
  starting: { icon: "↗", label: "Starting" },
  idle: { icon: "○", label: "Idle" },
  running: { icon: "⠋", label: "Running" },
  waiting: { icon: "…", label: "Waiting" },
  retrying: { icon: "↻", label: "Retrying" },
  compacting: { icon: "◇", label: "Compacting" },
  paused: { icon: "Ⅱ", label: "Paused" },
  blocked: { icon: "!", label: "Blocked" },
  aborting: { icon: "×", label: "Aborting" },
  completed: { icon: "✓", label: "Completed" },
  failed: { icon: "✗", label: "Failed" },
  replaced: { icon: "↪", label: "Replaced" },
  closed: { icon: "—", label: "Closed" },
  orphaned: { icon: "?", label: "Orphaned" },
};

export function createDashboardViewModel(
  snapshots: readonly AgentSnapshot[],
  now = new Date(),
  lastWatchdogAt?: Date,
): DashboardViewModel {
  const rows = snapshots.map((snapshot) => {
    const presentation = STATUS_PRESENTATION[snapshot.status];
    return {
      id: snapshot.agentId,
      name: snapshot.name,
      status: snapshot.status,
      statusLabel: presentation.label,
      icon: presentation.icon,
      task: snapshot.task ?? "No task assigned",
      currentActivity: snapshot.currentTool ?? snapshot.statusReason ?? presentation.label,
      elapsed: formatDuration(now.getTime() - new Date(snapshot.startedAt).getTime()),
      queuedMessages: snapshot.queuedMessages,
      ...(snapshot.worktree === undefined ? {} : { worktree: snapshot.worktree }),
      ...(snapshot.branch === undefined ? {} : { branch: snapshot.branch }),
      ...(snapshot.tmuxTarget === undefined ? {} : { tmuxTarget: snapshot.tmuxTarget }),
      ...(snapshot.statusReason === undefined ? {} : { statusReason: snapshot.statusReason }),
    } satisfies AgentRowViewModel;
  });

  const nextReview = snapshots
    .map((item) => item.nextParentReviewAt)
    .filter((value): value is string => value !== undefined)
    .map((value) => new Date(value).getTime())
    .sort((a, b) => a - b)[0];

  return {
    rows,
    counts: {
      running: snapshots.filter((item) => ["running", "waiting", "retrying", "compacting"].includes(item.status)).length,
      queued: snapshots.filter((item) => item.status === "queued").length,
      idle: snapshots.filter((item) => item.status === "idle").length,
      attention: snapshots.filter((item) => ["blocked", "failed", "orphaned"].includes(item.status)).length,
    },
    watchdogText: lastWatchdogAt ? `checked ${formatDuration(now.getTime() - lastWatchdogAt.getTime())} ago` : "not checked",
    parentReviewText: nextReview === undefined
      ? "not scheduled"
      : nextReview >= now.getTime()
        ? `in ${formatDuration(nextReview - now.getTime())}`
        : `overdue by ${formatDuration(now.getTime() - nextReview)}`,
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
