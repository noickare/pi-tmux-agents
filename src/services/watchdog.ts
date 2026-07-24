import { join } from "node:path";
import type { AgentSnapshot } from "../core/protocol.js";
import { isTerminalStatus } from "../core/state-machine.js";
import { AgentStateStore } from "../core/state-store.js";
import type { AdmissionQueue } from "./admission-queue.js";
import type { ResourceProbe } from "./resource-probe.js";
import { assessResourcePressure, type SchedulerThresholds } from "./scheduler.js";
import { SnapshotMonitor } from "./snapshot-monitor.js";
import { TmuxService } from "./tmux.js";
import type { WorktreeService } from "./worktrees.js";

export interface WatchdogFinding {
  agentId: string;
  severity: "warning" | "error";
  kind:
    | "heartbeat_stale"
    | "progress_stale"
    | "process_missing"
    | "tmux_missing"
    | "worktree_invalid"
    | "resource_pressure"
    | "queue_unhealthy"
    | "retries_repeated"
    | "tool_failures"
    | "ui_request_stale"
    | "state_inconsistent";
  message: string;
}

export interface WatchdogOptions {
  heartbeatStaleMs?: number;
  progressStaleMs?: number;
  uiRequestStaleMs?: number;
  queueStaleMs?: number;
  eventWindowMs?: number;
  repeatedFailureCount?: number;
  now?: () => Date;
  resourceProbe?: Pick<ResourceProbe, "snapshot">;
  queue?: Pick<AdmissionQueue, "health">;
  worktrees?: Pick<WorktreeService, "isValid">;
  schedulerThresholds?: SchedulerThresholds;
}

export class AgentWatchdog {
  private readonly now: () => Date;
  constructor(
    private readonly monitor: SnapshotMonitor,
    private readonly tmux: TmuxService,
    private readonly options: WatchdogOptions = {},
  ) { this.now = options.now ?? (() => new Date()); }

  async check(): Promise<WatchdogFinding[]> {
    await this.monitor.scan();
    const findings: WatchdogFinding[] = [];
    const entries = await this.snapshots();
    const resourceChecks = new Map<string, Awaited<ReturnType<NonNullable<WatchdogOptions["resourceProbe"]>["snapshot"]>>>();
    const reportedResourcePaths = new Set<string>();
    for (const snapshot of entries) {
      if (isTerminalStatus(snapshot.status) || snapshot.status === "queued") continue;
      const heartbeatAge = this.age(snapshot.lastHeartbeatAt);
      if (heartbeatAge > (this.options.heartbeatStaleMs ?? 30_000)) {
        findings.push(finding(snapshot, "error", "heartbeat_stale", `No heartbeat for ${Math.floor(heartbeatAge / 1000)}s`));
      }
      if (["starting", "running", "waiting", "retrying", "compacting"].includes(snapshot.status)) {
        const progressAge = this.age(snapshot.lastProgressAt);
        if (progressAge > (this.options.progressStaleMs ?? 10 * 60_000)) {
          findings.push(finding(snapshot, "warning", "progress_stale", `No meaningful progress for ${Math.floor(progressAge / 60_000)}m`));
        }
      }
      if (snapshot.rpcPid !== undefined && !processAlive(snapshot.rpcPid)) {
        findings.push(finding(snapshot, "error", "process_missing", `RPC process ${snapshot.rpcPid} is missing`));
      }
      if (snapshot.tmuxTarget) {
        const [session, window] = snapshot.tmuxTarget.split(":");
        if (!session || !window || !(await this.tmux.hasSession(session)) || !(await this.windowExists(session, window))) {
          findings.push(finding(snapshot, "error", "tmux_missing", `tmux target ${snapshot.tmuxTarget} is missing`));
        }
      }
      if (snapshot.worktree && this.options.worktrees) {
        const result = await this.options.worktrees.isValid(snapshot.worktree, snapshot.branch);
        if (!result.valid) findings.push(finding(snapshot, "error", "worktree_invalid", result.detail));
      }
      if (snapshot.pendingUiRequest && this.age(snapshot.pendingUiRequest.createdAt) > (this.options.uiRequestStaleMs ?? 60_000)) {
        findings.push(finding(snapshot, "warning", "ui_request_stale", `Extension UI ${snapshot.pendingUiRequest.method} request has not been answered`));
      }
      if (snapshot.status === "idle" && snapshot.currentTool) {
        findings.push(finding(snapshot, "warning", "state_inconsistent", `Idle snapshot still reports active tool ${snapshot.currentTool}`));
      }
      if (snapshot.branch && !snapshot.worktree) {
        findings.push(finding(snapshot, "error", "state_inconsistent", `Branch ${snapshot.branch} has no recorded worktree`));
      }
      await this.checkRecentEvents(snapshot, findings);

      if (this.options.resourceProbe) {
        const path = snapshot.parentCwd ?? snapshot.cwd;
        let resources = resourceChecks.get(path);
        if (!resources) {
          resources = await this.options.resourceProbe.snapshot(path, { activeWeight: 0 });
          resourceChecks.set(path, resources);
        }
        const pressure = assessResourcePressure(resources, this.options.schedulerThresholds);
        if (pressure !== "normal" && !reportedResourcePaths.has(path)) {
          reportedResourcePaths.add(path);
          findings.push({ agentId: "resources", severity: pressure === "critical" ? "error" : "warning", kind: "resource_pressure",
            message: `${pressure} pressure: ${formatBytes(resources.availableMemoryBytes)} memory and ${formatBytes(resources.availableDiskBytes)} disk available` });
        }
      }
    }

    if (this.options.queue) {
      const health = await this.options.queue.health(this.now().getTime());
      if (health.duplicateAgentIds.length) {
        findings.push({ agentId: "queue", severity: "error", kind: "queue_unhealthy", message: `Duplicate queued agents: ${health.duplicateAgentIds.join(", ")}` });
      } else if (health.count && health.oldestAgeMs > (this.options.queueStaleMs ?? 30 * 60_000)) {
        findings.push({ agentId: "queue", severity: "warning", kind: "queue_unhealthy", message: `Oldest of ${health.count} queued agents has waited ${Math.floor(health.oldestAgeMs / 60_000)}m` });
      }
    }
    return deduplicate(findings);
  }

  private async checkRecentEvents(snapshot: AgentSnapshot, findings: WatchdogFinding[]): Promise<void> {
    const { records } = await new AgentStateStore(join(this.monitor.stateRoot, snapshot.agentId)).readEvents();
    const cutoff = this.now().getTime() - (this.options.eventWindowMs ?? 10 * 60_000);
    const recent = records.filter((event) => new Date(event.createdAt).getTime() >= cutoff);
    const retryCount = recent.filter((event) => event.type === "status_changed" && event.payload?.status === "retrying").length;
    const toolFailures = recent.filter((event) => event.type === "tool_finished" && event.payload?.isError === true).length;
    const threshold = this.options.repeatedFailureCount ?? 3;
    if (retryCount >= threshold) findings.push(finding(snapshot, "warning", "retries_repeated", `${retryCount} provider retries in the recent event window`));
    if (toolFailures >= threshold) findings.push(finding(snapshot, "warning", "tool_failures", `${toolFailures} tool failures in the recent event window`));
  }

  private age(timestamp: string): number { return this.now().getTime() - new Date(timestamp).getTime(); }

  private async snapshots(): Promise<AgentSnapshot[]> {
    let entries;
    try { entries = await import("node:fs/promises").then(({ readdir }) => readdir(this.monitor.stateRoot, { withFileTypes: true })); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const snapshots: AgentSnapshot[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const snapshot = await new AgentStateStore(join(this.monitor.stateRoot, entry.name)).readSnapshot();
      if (snapshot) snapshots.push(snapshot);
    }
    return snapshots;
  }

  private async windowExists(session: string, window: string): Promise<boolean> {
    try { return (await this.tmux.listWindows(session)).some((candidate) => candidate.name === window); }
    catch { return false; }
  }
}

function finding(snapshot: AgentSnapshot, severity: WatchdogFinding["severity"], kind: WatchdogFinding["kind"], message: string): WatchdogFinding {
  return { agentId: snapshot.agentId, severity, kind, message };
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function deduplicate(findings: WatchdogFinding[]): WatchdogFinding[] {
  const seen = new Set<string>();
  return findings.filter((item) => {
    const key = `${item.agentId}:${item.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatBytes(value: number): string {
  return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)}GiB` : `${Math.floor(value / 1024 ** 2)}MiB`;
}
