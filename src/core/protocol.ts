export const PROTOCOL_VERSION = 1 as const;

export type AgentStatus =
  | "creating"
  | "queued"
  | "starting"
  | "idle"
  | "running"
  | "waiting"
  | "retrying"
  | "compacting"
  | "paused"
  | "blocked"
  | "aborting"
  | "completed"
  | "failed"
  | "replaced"
  | "closed"
  | "orphaned";

export type AgentCommandType =
  | "prompt"
  | "steer"
  | "follow_up"
  | "pause"
  | "resume"
  | "abort"
  | "restart"
  | "close";

export interface AgentCommand {
  protocolVersion: typeof PROTOCOL_VERSION;
  id: string;
  agentId: string;
  type: AgentCommandType;
  createdAt: string;
  payload?: Readonly<Record<string, unknown>>;
}

export type AgentEventType =
  | "heartbeat"
  | "status_changed"
  | "message_delta"
  | "tool_started"
  | "tool_updated"
  | "tool_finished"
  | "queue_changed"
  | "resource_changed"
  | "usage_changed"
  | "diagnostic"
  | "command_acknowledged"
  | "runner_stopped";

export interface AgentEvent {
  protocolVersion: typeof PROTOCOL_VERSION;
  id: string;
  agentId: string;
  sequence: number;
  type: AgentEventType;
  createdAt: string;
  commandId?: string;
  payload?: Readonly<Record<string, unknown>>;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
}

export interface AgentSnapshot {
  protocolVersion: typeof PROTOCOL_VERSION;
  agentId: string;
  name: string;
  status: AgentStatus;
  task?: string;
  statusReason?: string;
  currentTool?: string;
  cwd: string;
  worktree?: string;
  branch?: string;
  tmuxTarget?: string;
  model?: string;
  pid?: number;
  rpcPid?: number;
  sessionFile?: string;
  startedAt: string;
  updatedAt: string;
  lastHeartbeatAt: string;
  lastProgressAt: string;
  lastCompletedAt?: string;
  nextParentReviewAt?: string;
  queuedMessages: number;
  usage: AgentUsage;
  lastSequence: number;
}

export function createCommand(input: Omit<AgentCommand, "protocolVersion" | "createdAt"> & { createdAt?: string }): AgentCommand {
  return {
    protocolVersion: PROTOCOL_VERSION,
    createdAt: input.createdAt ?? new Date().toISOString(),
    id: input.id,
    agentId: input.agentId,
    type: input.type,
    ...(input.payload === undefined ? {} : { payload: input.payload }),
  };
}

export function isAgentCommand(value: unknown): value is AgentCommand {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<AgentCommand>;
  return (
    item.protocolVersion === PROTOCOL_VERSION &&
    typeof item.id === "string" && item.id.length > 0 &&
    typeof item.agentId === "string" && item.agentId.length > 0 &&
    typeof item.createdAt === "string" &&
    typeof item.type === "string" &&
    COMMAND_TYPES.has(item.type as AgentCommandType)
  );
}

const COMMAND_TYPES = new Set<AgentCommandType>([
  "prompt", "steer", "follow_up", "pause", "resume", "abort", "restart", "close",
]);
