import type { AgentStatus } from "./protocol.js";

const TERMINAL = new Set<AgentStatus>(["completed", "failed", "replaced", "closed", "orphaned"]);

const TRANSITIONS: Readonly<Record<AgentStatus, ReadonlySet<AgentStatus>>> = {
  creating: new Set(["queued", "starting", "failed", "closed", "replaced"]),
  queued: new Set(["starting", "closed", "failed", "replaced"]),
  starting: new Set(["idle", "running", "failed", "orphaned", "closed", "replaced"]),
  idle: new Set(["starting", "running", "paused", "closed", "orphaned", "failed", "replaced"]),
  running: new Set(["starting", "idle", "waiting", "retrying", "compacting", "paused", "blocked", "aborting", "completed", "failed", "closed", "orphaned", "replaced"]),
  waiting: new Set(["starting", "running", "idle", "paused", "blocked", "aborting", "failed", "closed", "orphaned", "replaced"]),
  retrying: new Set(["starting", "running", "paused", "blocked", "aborting", "failed", "closed", "orphaned", "replaced"]),
  compacting: new Set(["starting", "running", "paused", "aborting", "failed", "closed", "orphaned", "replaced"]),
  paused: new Set(["starting", "queued", "idle", "running", "aborting", "closed", "orphaned", "failed", "replaced"]),
  blocked: new Set(["starting", "running", "paused", "aborting", "failed", "replaced", "closed"]),
  aborting: new Set(["idle", "failed", "closed", "orphaned", "replaced"]),
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
