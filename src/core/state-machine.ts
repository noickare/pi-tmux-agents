import type { AgentStatus } from "./protocol.js";

const TERMINAL = new Set<AgentStatus>(["completed", "failed", "replaced", "closed", "orphaned"]);

const TRANSITIONS: Readonly<Record<AgentStatus, ReadonlySet<AgentStatus>>> = {
  creating: new Set(["queued", "starting", "failed", "closed"]),
  queued: new Set(["starting", "closed", "failed"]),
  starting: new Set(["idle", "running", "failed", "orphaned", "closed"]),
  idle: new Set(["starting", "running", "paused", "closed", "orphaned", "failed"]),
  running: new Set(["starting", "idle", "waiting", "retrying", "compacting", "paused", "blocked", "aborting", "completed", "failed", "closed", "orphaned"]),
  waiting: new Set(["starting", "running", "idle", "paused", "blocked", "aborting", "failed", "closed", "orphaned"]),
  retrying: new Set(["starting", "running", "paused", "blocked", "aborting", "failed", "closed", "orphaned"]),
  compacting: new Set(["starting", "running", "paused", "aborting", "failed", "closed", "orphaned"]),
  paused: new Set(["starting", "queued", "idle", "running", "aborting", "closed", "orphaned", "failed"]),
  blocked: new Set(["starting", "running", "paused", "aborting", "failed", "replaced", "closed"]),
  aborting: new Set(["idle", "failed", "closed", "orphaned"]),
  completed: new Set(["idle", "closed", "replaced"]),
  failed: new Set(["queued", "starting", "replaced", "closed"]),
  replaced: new Set(["closed"]),
  closed: new Set(),
  orphaned: new Set(["queued", "starting", "replaced", "closed"]),
};

export function isTerminalStatus(status: AgentStatus): boolean {
  return TERMINAL.has(status);
}

export function canTransition(from: AgentStatus, to: AgentStatus): boolean {
  return from === to || TRANSITIONS[from].has(to);
}

export function assertTransition(from: AgentStatus, to: AgentStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid agent status transition: ${from} -> ${to}`);
  }
}
