import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCommand } from "../core/protocol.js";
import { AgentStateStore } from "../core/state-store.js";
import type { AgentJob } from "../runner/job.js";
import { writeAgentJob } from "../runner/job.js";
import { TmuxService } from "./tmux.js";

export interface LaunchAgentInput {
  parentSessionId: string;
  agentId: string;
  name: string;
  cwd: string;
  stateDirectory: string;
  prompt?: string;
  model?: string;
  tools?: readonly string[];
  systemPrompt?: string;
  approveProject?: boolean;
  worktree?: string;
  branch?: string;
}

export interface LaunchedAgent {
  job: AgentJob;
  jobPath: string;
}

export class RunnerLauncher {
  constructor(private readonly tmux: TmuxService) {}

  async launch(input: LaunchAgentInput): Promise<LaunchedAgent> {
    await mkdir(input.stateDirectory, { recursive: true, mode: 0o700 });
    const session = `pi-agents-${input.parentSessionId}`;
    const target = this.tmux.target(session, input.agentId);
    const job: AgentJob = {
      protocolVersion: 1,
      parentSessionId: input.parentSessionId,
      agentId: input.agentId,
      name: input.name,
      cwd: input.cwd,
      stateDirectory: input.stateDirectory,
      sessionId: randomUUID(),
      tmuxTarget: target,
      approveProject: input.approveProject ?? false,
      ...(input.worktree ? { worktree: input.worktree } : {}),
      ...(input.branch ? { branch: input.branch } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.tools?.length ? { tools: input.tools } : {}),
      ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
    };
    const jobPath = join(input.stateDirectory, "agent.json");
    await writeAgentJob(jobPath, job);
    const store = new AgentStateStore(input.stateDirectory);
    if (input.prompt) {
      await store.appendCommand(createCommand({
        id: randomUUID(),
        agentId: input.agentId,
        type: "prompt",
        payload: { message: input.prompt },
      }));
    }

    const command = runnerCommand(jobPath);
    if (await this.tmux.hasSession(session)) await this.tmux.createWindow(session, input.agentId, command, input.cwd);
    else await this.tmux.createSession(session, input.agentId, command, input.cwd);
    return { job, jobPath };
  }
}

export function runnerCommand(jobPath: string): readonly string[] {
  const require = createRequire(import.meta.url);
  const tsxCli = require.resolve("tsx/cli");
  const runner = fileURLToPath(new URL("../runner/cli.ts", import.meta.url));
  return [process.execPath, tsxCli, runner, "--job", jobPath];
}
