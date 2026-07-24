import { homedir } from "node:os";
import { join } from "node:path";

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function assertSafeId(value: string, label = "id"): string {
  if (!SAFE_ID.test(value)) throw new Error(`Invalid ${label}: ${value}`);
  return value;
}

export function getAgentStateRoot(parentSessionId: string, agentDir = join(homedir(), ".pi", "agent")): string {
  return join(agentDir, "subagents", assertSafeId(parentSessionId, "parent session id"));
}

export function getAgentStateDir(parentSessionId: string, agentId: string, agentDir?: string): string {
  return join(getAgentStateRoot(parentSessionId, agentDir), assertSafeId(agentId, "agent id"));
}
