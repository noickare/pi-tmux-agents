import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { assertSafeId } from "../core/paths.js";
import { PROTOCOL_VERSION, type AgentPriority, type AgentWeight } from "../core/protocol.js";

export interface AgentJob {
  protocolVersion: typeof PROTOCOL_VERSION;
  parentSessionId: string;
  agentId: string;
  name: string;
  cwd: string;
  stateDirectory: string;
  sessionId: string;
  tmuxTarget: string;
  approveProject: boolean;
  priority?: AgentPriority;
  weight?: AgentWeight;
  mutating?: boolean;
  parentCwd?: string;
  replaces?: string;
  worktree?: string;
  branch?: string;
  baseCommit?: string;
  model?: string;
  tools?: readonly string[];
  systemPrompt?: string;
}

export async function readAgentJob(path: string): Promise<AgentJob> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isAgentJob(value)) throw new Error(`Invalid agent job: ${path}`);
  return value;
}

export async function writeAgentJob(path: string, job: AgentJob): Promise<void> {
  if (!isAgentJob(job)) throw new Error("Refusing to write an invalid agent job");
  if (dirname(path) !== job.stateDirectory) throw new Error("Job file must be inside its state directory");
  await writeFile(path, `${JSON.stringify(job, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function isAgentJob(value: unknown): value is AgentJob {
  if (!value || typeof value !== "object") return false;
  const job = value as Partial<AgentJob>;
  try {
    if (typeof job.parentSessionId === "string") assertSafeId(job.parentSessionId, "parent session id");
    if (typeof job.agentId === "string") assertSafeId(job.agentId, "agent id");
  } catch {
    return false;
  }
  return job.protocolVersion === PROTOCOL_VERSION && typeof job.parentSessionId === "string" &&
    typeof job.agentId === "string" && typeof job.name === "string" && job.name.length > 0 &&
    typeof job.cwd === "string" && typeof job.stateDirectory === "string" && typeof job.sessionId === "string" &&
    typeof job.tmuxTarget === "string" && job.tmuxTarget.length > 0 && typeof job.approveProject === "boolean";
}
