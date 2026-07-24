import { join } from "node:path";
import type { AgentSnapshot } from "../core/protocol.js";
import { isTerminalStatus } from "../core/state-machine.js";
import { AgentStateStore } from "../core/state-store.js";
import { SnapshotMonitor } from "./snapshot-monitor.js";
import { TmuxService } from "./tmux.js";

export interface WatchdogFinding {
  agentId: string;
  severity: "warning" | "error";
  kind: "heartbeat_stale" | "progress_stale" | "process_missing" | "tmux_missing";
  message: string;
}

export interface WatchdogOptions {
  heartbeatStaleMs?: number;
  progressStaleMs?: number;
  now?: () => Date;
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
    for (const snapshot of entries) {
      if (isTerminalStatus(snapshot.status) || snapshot.status === "queued") continue;
      const heartbeatAge = this.now().getTime() - new Date(snapshot.lastHeartbeatAt).getTime();
      if (heartbeatAge > (this.options.heartbeatStaleMs ?? 30_000)) {
        findings.push({ agentId: snapshot.agentId, severity: "error", kind: "heartbeat_stale", message: `No heartbeat for ${Math.floor(heartbeatAge / 1000)}s` });
      }
      if (["starting", "running", "waiting", "retrying", "compacting"].includes(snapshot.status)) {
        const progressAge = this.now().getTime() - new Date(snapshot.lastProgressAt).getTime();
        if (progressAge > (this.options.progressStaleMs ?? 10 * 60_000)) {
          findings.push({ agentId: snapshot.agentId, severity: "warning", kind: "progress_stale", message: `No meaningful progress for ${Math.floor(progressAge / 60_000)}m` });
        }
      }
      if (snapshot.rpcPid !== undefined && !processAlive(snapshot.rpcPid)) {
        findings.push({ agentId: snapshot.agentId, severity: "error", kind: "process_missing", message: `RPC process ${snapshot.rpcPid} is missing` });
      }
      if (snapshot.tmuxTarget) {
        const [session, window] = snapshot.tmuxTarget.split(":");
        if (!session || !window || !(await this.tmux.hasSession(session)) || !(await this.windowExists(session, window))) {
          findings.push({ agentId: snapshot.agentId, severity: "error", kind: "tmux_missing", message: `tmux target ${snapshot.tmuxTarget} is missing` });
        }
      }
    }
    return deduplicate(findings);
  }

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

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function deduplicate(findings: WatchdogFinding[]): WatchdogFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.agentId}:${finding.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
