import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AgentDefinition } from "../core/agents.js";
import { getAgentStateDir, getAgentStateRoot } from "../core/paths.js";
import { createCommand, PROTOCOL_VERSION, type AgentCommandType, type AgentSnapshot } from "../core/protocol.js";
import { AgentRegistry } from "../core/registry.js";
import { AgentStateStore } from "../core/state-store.js";
import { AdmissionQueue, type QueuedSpawn } from "./admission-queue.js";
import { ResourceProbe } from "./resource-probe.js";
import { RunnerLauncher } from "./runner-launcher.js";
import { decideAdmission } from "./scheduler.js";
import { WorktreeService } from "./worktrees.js";

export interface SpawnAgentInput {
  name: string;
  task: string;
  cwd: string;
  definition?: AgentDefinition;
  model?: string;
  tools?: readonly string[];
  mutating?: boolean;
  approveProject?: boolean;
}

export interface SpawnedAgent {
  agentId: string;
  stateDirectory: string;
  queued: boolean;
  queueReason?: string;
  worktree?: string;
  branch?: string;
  tmuxTarget?: string;
}

export interface OrchestratorOptions {
  resourceProbe?: Pick<ResourceProbe, "snapshot">;
  queue?: AdmissionQueue;
}

export class AgentOrchestrator {
  private readonly queue: AdmissionQueue;
  constructor(
    readonly parentSessionId: string,
    readonly agentDir: string,
    private readonly registry: AgentRegistry,
    private readonly launcher: RunnerLauncher,
    private readonly worktrees: WorktreeService,
    private readonly options: OrchestratorOptions = {},
  ) {
    this.queue = options.queue ?? new AdmissionQueue(join(getAgentStateRoot(parentSessionId, agentDir), "queue.json"));
  }

  list(): readonly AgentSnapshot[] { return this.registry.list(); }
  get(agentId: string): AgentSnapshot | undefined { return this.registry.get(agentId); }

  async spawn(input: SpawnAgentInput): Promise<SpawnedAgent> {
    const agentId = uniqueAgentId(input.name);
    const decision = await this.admission(input);
    if (!decision.admitted) {
      const queued: QueuedSpawn = { id: randomUUID(), agentId, createdAt: new Date().toISOString(), reason: decision.reason, input };
      await this.queue.add(queued);
      await this.writeQueuedSnapshot(queued);
      return {
        agentId,
        stateDirectory: getAgentStateDir(this.parentSessionId, agentId, this.agentDir),
        queued: true,
        queueReason: decision.reason,
      };
    }
    return this.launch(agentId, input);
  }

  async drainQueue(): Promise<number> {
    let admitted = 0;
    for (const item of await this.queue.list()) {
      const decision = await this.admission(item.input);
      if (!decision.admitted) continue;
      await this.launch(item.agentId, item.input);
      await this.queue.remove(item.id);
      admitted++;
    }
    return admitted;
  }

  async command(agentId: string, type: AgentCommandType, message?: string): Promise<string> {
    const snapshot = this.requireAgent(agentId);
    const id = randomUUID();
    await new AgentStateStore(getAgentStateDir(this.parentSessionId, snapshot.agentId, this.agentDir)).appendCommand(createCommand({
      id,
      agentId: snapshot.agentId,
      type,
      ...(message === undefined ? {} : { payload: { message } }),
    }));
    return id;
  }

  async merge(agentId: string, parentRepo: string): Promise<void> {
    const snapshot = this.requireAgent(agentId);
    if (!snapshot.branch) throw new Error(`Agent ${agentId} has no worktree branch`);
    const status = snapshot.worktree ? await this.worktrees.status(snapshot.worktree) : "";
    if (status.split("\n").slice(1).some((line) => line.trim())) throw new Error(`Agent ${agentId} worktree is dirty`);
    await this.worktrees.merge(parentRepo, snapshot.branch);
  }

  async closeAndClean(agentId: string, parentRepo: string, discard = false): Promise<void> {
    const snapshot = this.requireAgent(agentId);
    await this.command(agentId, "close");
    const store = new AgentStateStore(getAgentStateDir(this.parentSessionId, snapshot.agentId, this.agentDir));
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if ((await store.readSnapshot())?.status === "closed") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if ((await store.readSnapshot())?.status !== "closed") throw new Error(`Timed out closing ${agentId}; worktree retained`);
    if (snapshot.worktree) await this.worktrees.remove(parentRepo, snapshot.worktree, discard);
    if (snapshot.branch) await this.worktrees.deleteBranch(parentRepo, snapshot.branch, discard);
  }

  private async launch(agentId: string, input: SpawnAgentInput): Promise<SpawnedAgent> {
    const stateDirectory = getAgentStateDir(this.parentSessionId, agentId, this.agentDir);
    let cwd = input.cwd;
    let worktree: string | undefined;
    let branch: string | undefined;
    if (input.mutating ?? true) {
      const spec = this.worktrees.derive(input.cwd, agentId);
      await this.worktrees.create(input.cwd, spec);
      cwd = spec.path;
      worktree = spec.path;
      branch = spec.branch;
    }
    try {
      const model = input.model ?? input.definition?.model;
      const tools = input.tools ?? input.definition?.tools;
      const launched = await this.launcher.launch({
        parentSessionId: this.parentSessionId,
        agentId,
        name: input.name,
        cwd,
        stateDirectory,
        prompt: input.task,
        ...(input.approveProject === undefined ? {} : { approveProject: input.approveProject }),
        ...(worktree ? { worktree } : {}),
        ...(branch ? { branch } : {}),
        ...(model ? { model } : {}),
        ...(tools ? { tools } : {}),
        ...(input.definition?.systemPrompt ? { systemPrompt: input.definition.systemPrompt } : {}),
      });
      return {
        agentId,
        stateDirectory,
        queued: false,
        tmuxTarget: launched.job.tmuxTarget,
        ...(worktree ? { worktree } : {}),
        ...(branch ? { branch } : {}),
      };
    } catch (error) {
      if (worktree) await this.worktrees.remove(input.cwd, worktree).catch(() => undefined);
      throw error;
    }
  }

  private async admission(input: SpawnAgentInput) {
    if (!this.options.resourceProbe) return { admitted: true, reason: "resource probe disabled" } as const;
    const activeWeight = this.registry.list().filter((agent) => ["running", "waiting", "retrying", "compacting", "starting"].includes(agent.status)).length;
    const resources = await this.options.resourceProbe.snapshot(input.cwd, { activeWeight });
    return decideAdmission(resources, (input.mutating ?? true) ? "heavy" : "light");
  }

  private async writeQueuedSnapshot(item: QueuedSpawn): Promise<void> {
    const timestamp = new Date().toISOString();
    const snapshot: AgentSnapshot = {
      protocolVersion: PROTOCOL_VERSION,
      agentId: item.agentId,
      name: item.input.name,
      status: "queued",
      task: item.input.task,
      statusReason: item.reason,
      cwd: item.input.cwd,
      startedAt: timestamp,
      updatedAt: timestamp,
      lastHeartbeatAt: timestamp,
      lastProgressAt: timestamp,
      queuedMessages: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 },
      lastSequence: 0,
    };
    await new AgentStateStore(getAgentStateDir(this.parentSessionId, item.agentId, this.agentDir)).writeSnapshot(snapshot);
    this.registry.upsert(snapshot);
  }

  private requireAgent(agentId: string): AgentSnapshot {
    const exact = this.registry.get(agentId);
    if (exact) return exact;
    const matches = this.registry.list().filter((agent) => agent.agentId.startsWith(agentId) || agent.name === agentId);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) throw new Error(`Ambiguous agent: ${agentId}`);
    throw new Error(`Unknown agent: ${agentId}`);
  }
}

function uniqueAgentId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "agent";
  return `${slug}-${randomUUID().slice(0, 8)}`;
}
