import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCommand, PROTOCOL_VERSION, type AgentPriority, type AgentWeight } from "../core/protocol.js";
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
  priority?: AgentPriority;
  weight?: AgentWeight;
  mutating?: boolean;
  parentCwd?: string;
  replaces?: string;
  worktree?: string;
  branch?: string;
  baseCommit?: string;
}

export interface LaunchedAgent {
  job: AgentJob;
  jobPath: string;
}

export class RunnerLauncher {
  private readonly sessionLaunches = new Map<string, Promise<void>>();

  constructor(private readonly tmux: TmuxService) {}

  async launch(input: LaunchAgentInput): Promise<LaunchedAgent> {
    await mkdir(input.stateDirectory, { recursive: true, mode: 0o700 });
    const session = `pi-agents-${input.parentSessionId}`;
    const target = this.tmux.target(session, input.agentId);
    const job: AgentJob = {
      protocolVersion: PROTOCOL_VERSION,
      parentSessionId: input.parentSessionId,
      agentId: input.agentId,
      name: input.name,
      cwd: input.cwd,
      stateDirectory: input.stateDirectory,
      sessionId: randomUUID(),
      tmuxTarget: target,
      approveProject: input.approveProject ?? false,
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.weight ? { weight: input.weight } : {}),
      ...(input.mutating === undefined ? {} : { mutating: input.mutating }),
      ...(input.parentCwd ? { parentCwd: input.parentCwd } : {}),
      ...(input.replaces ? { replaces: input.replaces } : {}),
      ...(input.worktree ? { worktree: input.worktree } : {}),
      ...(input.branch ? { branch: input.branch } : {}),
      ...(input.baseCommit ? { baseCommit: input.baseCommit } : {}),
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
    try {
      await this.launchWindow(session, input.agentId, command, input.cwd);
      return { job, jobPath };
    } catch (error) {
      await rm(input.stateDirectory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async launchWindow(session: string, window: string, command: readonly string[], cwd: string): Promise<void> {
    const previous = this.sessionLaunches.get(session) ?? Promise.resolve();
    const launch = previous.catch(() => undefined).then(async () => {
      if (await this.tmux.hasSession(session)) {
        await this.tmux.createWindow(session, window, command, cwd);
        return;
      }
      try {
        await this.tmux.createSession(session, window, command, cwd);
      } catch (error) {
        if (!await this.tmux.hasSession(session)) throw error;
        await this.tmux.createWindow(session, window, command, cwd);
      }
    });
    this.sessionLaunches.set(session, launch);
    try { await launch; }
    finally { if (this.sessionLaunches.get(session) === launch) this.sessionLaunches.delete(session); }
  }
}

export function runnerCommand(jobPath: string): readonly string[] {
  const require = createRequire(import.meta.url);
  const tsxCli = require.resolve("tsx/cli");
  const runner = fileURLToPath(new URL("../runner/cli.ts", import.meta.url));
  return [process.execPath, tsxCli, runner, "--job", jobPath];
}
