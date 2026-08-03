import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AgentDefinition } from "../core/agents.js";
import { getAgentStateDir, getAgentStateRoot } from "../core/paths.js";
import {
  createCommand,
  PROTOCOL_VERSION,
  type AgentCommandType,
  type AgentPriority,
  type AgentSnapshot,
  type AgentWeight,
} from "../core/protocol.js";
import { AgentRegistry } from "../core/registry.js";
import { isTerminalStatus } from "../core/state-machine.js";
import { AgentStateStore } from "../core/state-store.js";
import { readAgentJob } from "../runner/job.js";
import { AdmissionQueue, type QueuedSpawn } from "./admission-queue.js";
import { ResourceProbe, type ResourceProbeOptions } from "./resource-probe.js";
import { RunnerLauncher } from "./runner-launcher.js";
import { assessResourcePressure, PRIORITY_RANK, type ResourceSnapshot, type SchedulerThresholds } from "./scheduler.js";
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
  priority?: AgentPriority;
  weight?: AgentWeight;
  replaces?: string;
}

export interface SpawnedAgent {
  agentId: string;
  stateDirectory: string;
  queued: boolean;
  queueReason?: string;
  worktree?: string;
  branch?: string;
  tmuxTarget?: string;
  replaces?: string;
}

export interface ValidationResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RebalanceResult {
  pressure: "normal" | "elevated" | "critical";
  paused: readonly string[];
  resumed: readonly string[];
  resources: ResourceSnapshot;
}

export interface OrchestratorOptions {
  resourceProbe?: Pick<ResourceProbe, "snapshot">;
  queue?: AdmissionQueue;
  resourceProbeOptions?: ResourceProbeOptions;
  schedulerThresholds?: SchedulerThresholds;
  resourceRecoveryStableMs?: number;
  now?: () => number;
}

export class AgentOrchestrator {
  private readonly queue: AdmissionQueue;
  private readonly automaticallyPaused = new Set<string>();
  private readonly automaticResumePending = new Set<string>();
  private readonly cleanupRuns = new Map<string, Promise<void>>();
  private normalPressureSince: number | undefined;

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
  queueState(): Promise<readonly QueuedSpawn[]> { return this.queue.list(); }
  queueHealth() { return this.queue.health(); }

  async spawn(input: SpawnAgentInput): Promise<SpawnedAgent> {
    const normalized = normalizeInput(input);
    const agentId = uniqueAgentId(normalized.name);
    const decision = await this.admission(normalized);
    if (!decision.admitted) return this.enqueue(agentId, normalized, decision.reason);
    return this.launch(agentId, normalized);
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

  async command(
    agentId: string,
    type: AgentCommandType,
    message?: string,
    payload: Readonly<Record<string, unknown>> = {},
  ): Promise<string> {
    const snapshot = this.requireAgent(agentId);
    assertCommandAllowed(snapshot, type);
    const effectiveType = snapshot.status === "idle" && (type === "steer" || type === "follow_up") ? "prompt" : type;
    const id = randomUUID();
    const commandPayload = { ...payload, ...(message === undefined ? {} : { message }) };
    await new AgentStateStore(getAgentStateDir(this.parentSessionId, snapshot.agentId, this.agentDir)).appendCommand(createCommand({
      id,
      agentId: snapshot.agentId,
      type: effectiveType,
      ...(Object.keys(commandPayload).length ? { payload: commandPayload } : {}),
    }));
    return id;
  }

  async setPriority(agentId: string, priority: AgentPriority): Promise<void> {
    const snapshot = this.requireAgent(agentId);
    if (snapshot.status === "queued") {
      if (!await this.queue.reprioritize(snapshot.agentId, priority)) throw new Error(`Queued request for ${snapshot.agentId} is missing`);
      const updated = { ...snapshot, priority, updatedAt: new Date().toISOString() };
      await new AgentStateStore(getAgentStateDir(this.parentSessionId, snapshot.agentId, this.agentDir)).writeSnapshot(updated);
      this.registry.upsert(updated);
      return;
    }
    await this.command(snapshot.agentId, "set_priority", undefined, { priority });
  }

  async replace(agentId: string, reason = "Agent was stuck or unhealthy"): Promise<SpawnedAgent> {
    const snapshot = this.requireAgent(agentId);
    const replacementId = uniqueAgentId(snapshot.name);
    const oldDirectory = getAgentStateDir(this.parentSessionId, snapshot.agentId, this.agentDir);
    const oldStore = new AgentStateStore(oldDirectory);

    if (snapshot.status === "queued") {
      const queued = (await this.queue.list()).find((item) => item.agentId === snapshot.agentId);
      if (!queued) throw new Error(`Queued request for ${snapshot.agentId} is missing`);
      await this.queue.remove(queued.id);
      await oldStore.writeSnapshot({ ...snapshot, status: "replaced", statusReason: reason, replacedBy: replacementId, updatedAt: new Date().toISOString() });
      this.registry.upsert({ ...snapshot, status: "replaced", statusReason: reason, replacedBy: replacementId, updatedAt: new Date().toISOString() });
      const input = { ...queued.input, replaces: snapshot.agentId, task: handoffPrompt(snapshot, reason) };
      const decision = await this.admission(input);
      return decision.admitted ? this.launch(replacementId, input) : this.enqueue(replacementId, input, decision.reason);
    }

    const job = await readAgentJob(join(oldDirectory, "agent.json"));
    if (!isTerminalStatus(snapshot.status)) {
      await this.command(snapshot.agentId, "replace", undefined, { replacementAgentId: replacementId, reason });
      try {
        await waitForStatus(oldStore, "replaced", 15_000);
      } catch {
        const replaced = { ...snapshot, status: "replaced" as const, statusReason: `${reason}; previous runner did not acknowledge replacement`, replacedBy: replacementId, updatedAt: new Date().toISOString() };
        await oldStore.writeSnapshot(replaced);
        this.registry.upsert(replaced);
      }
    } else if (snapshot.status !== "replaced") {
      const replaced = { ...snapshot, status: "replaced" as const, statusReason: reason, replacedBy: replacementId, updatedAt: new Date().toISOString() };
      await oldStore.writeSnapshot(replaced);
      this.registry.upsert(replaced);
    }

    const transcript = await readTail(join(oldDirectory, "transcript.log"), 4_000);
    const prompt = `${handoffPrompt(snapshot, reason)}${transcript ? `\n\nRecent transcript from the previous agent:\n${transcript}` : ""}`;
    return this.launchExisting(replacementId, {
      name: snapshot.name,
      task: prompt,
      cwd: job.parentCwd ?? snapshot.parentCwd ?? (snapshot.worktree ? snapshot.cwd : job.cwd),
      ...(job.model ? { model: job.model } : {}),
      ...(job.tools ? { tools: job.tools } : {}),
      mutating: job.mutating ?? snapshot.mutating ?? Boolean(snapshot.worktree),
      approveProject: job.approveProject,
      priority: job.priority ?? snapshot.priority ?? "normal",
      weight: job.weight ?? snapshot.weight ?? (snapshot.worktree ? "heavy" : "light"),
      replaces: snapshot.agentId,
    }, {
      cwd: job.cwd,
      ...(job.worktree ? { worktree: job.worktree } : {}),
      ...(job.branch ? { branch: job.branch } : {}),
      ...(job.baseCommit ? { baseCommit: job.baseCommit } : {}),
      ...(job.systemPrompt ? { systemPrompt: job.systemPrompt } : {}),
    });
  }

  async result(agentId: string) {
    const snapshot = this.requireAgent(agentId);
    if (!snapshot.latestResult) throw new Error(`Agent ${snapshot.agentId} has no completed result`);
    const result = await new AgentStateStore(getAgentStateDir(this.parentSessionId, snapshot.agentId, this.agentDir))
      .readResult(snapshot.latestResult.assignmentId, snapshot.latestResult.attemptId);
    if (!result) throw new Error(`Result ${snapshot.latestResult.resultId} is missing`);
    return result;
  }

  async diff(agentId: string): Promise<string> {
    const snapshot = this.requireAgent(agentId);
    if (!snapshot.worktree) throw new Error(`Agent ${snapshot.agentId} has no worktree`);
    return cap(await this.worktrees.diff(snapshot.worktree, snapshot.baseCommit ?? "HEAD"));
  }

  async validate(agentId: string, command: readonly string[]): Promise<ValidationResult> {
    const snapshot = this.requireAgent(agentId);
    const result = await this.worktrees.validate(snapshot.worktree ?? snapshot.cwd, command);
    return { code: result.code, stdout: cap(result.stdout), stderr: cap(result.stderr) };
  }

  async merge(agentId: string, parentRepo: string): Promise<void> {
    const snapshot = this.requireAgent(agentId);
    if (!snapshot.branch) throw new Error(`Agent ${agentId} has no worktree branch`);
    const status = snapshot.worktree ? await this.worktrees.status(snapshot.worktree) : "";
    if (status.split("\n").slice(1).some((line) => line.trim())) throw new Error(`Agent ${agentId} worktree is dirty`);
    await this.worktrees.merge(parentRepo, snapshot.branch);
  }

  async closeAndClean(agentId: string, parentRepo: string, discard = false): Promise<void> {
    const lineage = this.replacementLineage(this.requireAgent(agentId));
    const owner = lineage.find((snapshot) => !lineage.some((candidate) => candidate.replaces === snapshot.agentId)) ?? lineage.at(-1)!;
    const existing = this.cleanupRuns.get(owner.agentId);
    if (existing) return existing;
    const operation = this.closeAndCleanOwned(owner, parentRepo, discard)
      .then(async () => {
        for (const snapshot of lineage) {
          await rm(getAgentStateDir(this.parentSessionId, snapshot.agentId, this.agentDir), { recursive: true, force: true });
          this.registry.remove(snapshot.agentId);
        }
      })
      .finally(() => {
        if (this.cleanupRuns.get(owner.agentId) === operation) this.cleanupRuns.delete(owner.agentId);
      });
    this.cleanupRuns.set(owner.agentId, operation);
    return operation;
  }

  private replacementLineage(start: AgentSnapshot): AgentSnapshot[] {
    const snapshots = this.registry.list();
    const ids = new Set([start.agentId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const snapshot of snapshots) {
        if (ids.has(snapshot.agentId)) continue;
        const connected = snapshots.some((candidate) => ids.has(candidate.agentId) && (
          candidate.replaces === snapshot.agentId || candidate.replacedBy === snapshot.agentId ||
          snapshot.replaces === candidate.agentId || snapshot.replacedBy === candidate.agentId
        ));
        if (connected) { ids.add(snapshot.agentId); changed = true; }
      }
    }
    return snapshots.filter((snapshot) => ids.has(snapshot.agentId));
  }

  private async closeAndCleanOwned(snapshot: AgentSnapshot, parentRepo: string, discard: boolean): Promise<void> {
    const activeOwner = snapshot.worktree && this.registry.list().find((item) => item.agentId !== snapshot.agentId && item.worktree === snapshot.worktree && !isTerminalStatus(item.status));
    if (activeOwner) throw new Error(`Worktree is still owned by active agent ${activeOwner.agentId}`);
    const runnerMayBeAlive = snapshot.pid !== undefined && processAlive(snapshot.pid);
    if (!["closed", "replaced"].includes(snapshot.status) && (!isTerminalStatus(snapshot.status) || runnerMayBeAlive)) {
      await this.command(snapshot.agentId, "close");
      await waitForStatus(new AgentStateStore(getAgentStateDir(this.parentSessionId, snapshot.agentId, this.agentDir)), "closed", 15_000);
    }
    if (snapshot.worktree) await this.worktrees.remove(parentRepo, snapshot.worktree, discard);
    if (snapshot.branch) await this.worktrees.deleteBranch(parentRepo, snapshot.branch, discard);
  }

  async clean(parentRepo: string, discard = false): Promise<{ cleaned: string[]; retained: Array<{ agentId: string; reason: string }> }> {
    const cleaned: string[] = [];
    const retained: Array<{ agentId: string; reason: string }> = [];
    for (const snapshot of this.registry.list().filter((item) => isTerminalStatus(item.status) && !item.replacedBy)) {
      try { await this.closeAndClean(snapshot.agentId, parentRepo, discard); cleaned.push(snapshot.agentId); }
      catch (error) { retained.push({ agentId: snapshot.agentId, reason: (error as Error).message }); }
    }
    return { cleaned, retained };
  }

  async resources(path: string): Promise<ResourceSnapshot | undefined> {
    if (!this.options.resourceProbe) return undefined;
    return this.options.resourceProbe.snapshot(path, this.resourceOptions());
  }

  async rebalance(path: string): Promise<RebalanceResult | undefined> {
    const resources = await this.resources(path);
    if (!resources) return undefined;
    for (const agentId of [...this.automaticResumePending]) {
      if (this.registry.get(agentId)?.status !== "paused") this.automaticResumePending.delete(agentId);
    }
    const pressure = assessResourcePressure(resources, this.options.schedulerThresholds);
    const paused: string[] = [];
    const resumed: string[] = [];

    if (pressure !== "normal") this.normalPressureSince = undefined;
    if (pressure === "critical") {
      const candidates = this.registry.list()
        .filter((item) => ["starting", "running", "waiting", "retrying", "compacting"].includes(item.status) &&
          (item.priority ?? "normal") !== "interactive" && !this.automaticallyPaused.has(item.agentId))
        .sort((left, right) => PRIORITY_RANK[right.priority ?? "normal"] - PRIORITY_RANK[left.priority ?? "normal"]);
      for (const candidate of candidates) {
        await this.command(candidate.agentId, "pause", undefined, { reason: "Auto-paused under critical resource pressure" });
        this.automaticallyPaused.add(candidate.agentId);
        paused.push(candidate.agentId);
      }
    } else if (pressure === "normal") {
      const now = this.options.now?.() ?? Date.now();
      this.normalPressureSince ??= now;
      if (now - this.normalPressureSince < (this.options.resourceRecoveryStableMs ?? 30_000)) {
        return { pressure, paused, resumed, resources };
      }
      for (const agentId of [...this.automaticallyPaused]) {
        if (this.registry.get(agentId)?.status !== "paused") this.automaticallyPaused.delete(agentId);
      }
      for (const candidate of this.registry.list().filter((item) => item.status === "paused" && !this.automaticResumePending.has(item.agentId) &&
        (this.automaticallyPaused.has(item.agentId) || item.statusReason === "Auto-paused under critical resource pressure"))) {
        await this.command(candidate.agentId, "resume");
        this.automaticallyPaused.delete(candidate.agentId);
        this.automaticResumePending.add(candidate.agentId);
        resumed.push(candidate.agentId);
      }
    }
    return { pressure, paused, resumed, resources };
  }

  private async launch(agentId: string, input: SpawnAgentInput): Promise<SpawnedAgent> {
    const stateDirectory = getAgentStateDir(this.parentSessionId, agentId, this.agentDir);
    let cwd = input.cwd;
    let worktree: string | undefined;
    let branch: string | undefined;
    let baseCommit: string | undefined;
    if (input.mutating ?? true) {
      baseCommit = await this.worktrees.currentCommit(input.cwd);
      const spec = this.worktrees.derive(input.cwd, agentId, baseCommit);
      await this.worktrees.create(input.cwd, spec);
      cwd = spec.path;
      worktree = spec.path;
      branch = spec.branch;
    }
    try {
      return await this.launchExisting(agentId, input, {
        cwd,
        ...(worktree ? { worktree } : {}),
        ...(branch ? { branch } : {}),
        ...(baseCommit ? { baseCommit } : {}),
        ...(input.definition?.systemPrompt ? { systemPrompt: input.definition.systemPrompt } : {}),
      });
    } catch (error) {
      if (worktree) await this.worktrees.remove(input.cwd, worktree).catch(() => undefined);
      throw error;
    }
  }

  private async launchExisting(
    agentId: string,
    input: SpawnAgentInput,
    existing: { cwd: string; worktree?: string; branch?: string; baseCommit?: string; systemPrompt?: string },
  ): Promise<SpawnedAgent> {
    const stateDirectory = getAgentStateDir(this.parentSessionId, agentId, this.agentDir);
    const model = input.model ?? input.definition?.model;
    const tools = input.tools ?? input.definition?.tools;
    const launched = await this.launcher.launch({
      parentSessionId: this.parentSessionId,
      agentId,
      name: input.name,
      cwd: existing.cwd,
      parentCwd: input.cwd,
      stateDirectory,
      prompt: input.task,
      ...(input.approveProject === undefined ? {} : { approveProject: input.approveProject }),
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.weight ? { weight: input.weight } : {}),
      ...(input.mutating === undefined ? {} : { mutating: input.mutating }),
      ...(input.replaces ? { replaces: input.replaces } : {}),
      ...(existing.worktree ? { worktree: existing.worktree } : {}),
      ...(existing.branch ? { branch: existing.branch } : {}),
      ...(existing.baseCommit ? { baseCommit: existing.baseCommit } : {}),
      ...(model ? { model } : {}),
      ...(tools ? { tools } : {}),
      ...(existing.systemPrompt ? { systemPrompt: existing.systemPrompt } : {}),
    });
    return {
      agentId,
      stateDirectory,
      queued: false,
      tmuxTarget: launched.job.tmuxTarget,
      ...(existing.worktree ? { worktree: existing.worktree } : {}),
      ...(existing.branch ? { branch: existing.branch } : {}),
      ...(input.replaces ? { replaces: input.replaces } : {}),
    };
  }

  private async enqueue(agentId: string, input: SpawnAgentInput, reason: string): Promise<SpawnedAgent> {
    const queued: QueuedSpawn = { id: randomUUID(), agentId, createdAt: new Date().toISOString(), reason, input };
    await this.queue.add(queued);
    await this.writeQueuedSnapshot(queued);
    return {
      agentId,
      stateDirectory: getAgentStateDir(this.parentSessionId, agentId, this.agentDir),
      queued: true,
      queueReason: reason,
      ...(input.replaces ? { replaces: input.replaces } : {}),
    };
  }

  private async admission(input: SpawnAgentInput) {
    if (!this.options.resourceProbe) return { admitted: true, reason: "resource probe disabled" } as const;
    const resources = await this.options.resourceProbe.snapshot(input.cwd, this.resourceOptions());
    return decideAdmission(resources, input.weight ?? ((input.mutating ?? true) ? "heavy" : "light"), this.options.schedulerThresholds);
  }

  private resourceOptions(): ResourceProbeOptions {
    const weight = { light: 0.5, normal: 1, heavy: 2 } as const;
    const activeWeight = this.registry.list()
      .filter((agent) => ["running", "waiting", "retrying", "compacting", "starting"].includes(agent.status))
      .reduce((total, agent) => total + weight[agent.weight ?? (agent.worktree ? "heavy" : "light")], 0);
    const providerBackoff = this.registry.list().some((agent) => agent.status === "retrying" || /rate.?limit|backoff/i.test(agent.statusReason ?? ""));
    return { ...this.options.resourceProbeOptions, activeWeight, providerBackoff };
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
      ...(item.input.priority ? { priority: item.input.priority } : {}),
      ...(item.input.weight ? { weight: item.input.weight } : {}),
      ...(item.input.mutating === undefined ? {} : { mutating: item.input.mutating }),
      parentCwd: item.input.cwd,
      ...(item.input.replaces ? { replaces: item.input.replaces } : {}),
      cwd: item.input.cwd,
      startedAt: timestamp,
      updatedAt: timestamp,
      lastHeartbeatAt: timestamp,
      lastProgressAt: timestamp,
      queuedMessages: 0,
      recentActivity: [{ at: timestamp, kind: "status", text: `queued: ${item.reason}` }],
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

function assertCommandAllowed(snapshot: AgentSnapshot, type: AgentCommandType): void {
  const reviewCommands = new Set<AgentCommandType>(["revise", "accept", "take_over", "escalate", "dismiss"]);
  if (snapshot.status === "awaiting_review") {
    if (["prompt", "steer", "follow_up", "close"].includes(type)) throw new Error(`Agent ${snapshot.agentId} awaits parent review; use revise, accept, take_over, escalate, or dismiss`);
  } else if (reviewCommands.has(type)) {
    throw new Error(`${type} requires an awaiting_review agent`);
  }
  if (type === "prompt" && snapshot.status !== "idle") throw new Error(`prompt requires an idle agent; ${snapshot.agentId} is ${snapshot.status}`);
}

function normalizeInput(input: SpawnAgentInput): SpawnAgentInput {
  return {
    ...input,
    mutating: input.mutating ?? true,
    priority: input.priority ?? "normal",
    weight: input.weight ?? ((input.mutating ?? true) ? "heavy" : "light"),
  };
}

function handoffPrompt(snapshot: AgentSnapshot, reason: string): string {
  return `Continue the previous agent's assignment in the existing worktree and branch.\n\nOriginal task: ${snapshot.task ?? "Unknown"}\nReplacement reason: ${reason}\nPrevious status: ${snapshot.status}${snapshot.statusReason ? ` (${snapshot.statusReason})` : ""}\nInspect the current worktree, Git diff, and commits before changing anything. Preserve valid work and complete the task.`;
}

async function waitForStatus(store: AgentStateStore, expected: AgentSnapshot["status"], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await store.readSnapshot())?.status === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for agent status ${expected}`);
}

async function readTail(path: string, maximum: number): Promise<string> {
  try { const value = await readFile(path, "utf8"); return value.slice(-maximum); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function cap(value: string, maximum = 24_000): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}\n… output truncated …`;
}

function uniqueAgentId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "agent";
  return `${slug}-${randomUUID().slice(0, 8)}`;
}
