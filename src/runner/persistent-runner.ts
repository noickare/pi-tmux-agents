import type { AgentCommand, AgentEvent, AgentEventType, AgentSnapshot, AgentStatus } from "../core/protocol.js";
import { PROTOCOL_VERSION } from "../core/protocol.js";
import { assertTransition } from "../core/state-machine.js";
import { AgentStateStore } from "../core/state-store.js";
import type { AgentJob } from "./job.js";
import type { RpcCommand, RpcEvent, RpcTransport } from "./rpc-types.js";
import { renderRpcEvent, type TranscriptWriter } from "./transcript.js";

export interface PersistentRunnerOptions {
  heartbeatIntervalMs?: number;
  commandPollIntervalMs?: number;
  now?: () => Date;
  output?: TranscriptWriter;
}

export type RpcTransportFactory = () => Promise<RpcTransport>;

export class PersistentAgentRunner {
  private transport: RpcTransport | undefined;
  private unsubscribe: (() => void) | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private readonly acknowledged = new Set<string>();
  private sequence = 0;
  private processing = false;
  private eventQueue = Promise.resolve();
  private statusBeforePause: AgentStatus = "idle";
  private snapshot: AgentSnapshot;
  private readonly now: () => Date;
  private readonly output: TranscriptWriter;

  constructor(
    private readonly job: AgentJob,
    private readonly store: AgentStateStore,
    private readonly createTransport: RpcTransportFactory,
    private readonly options: PersistentRunnerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.output = options.output ?? process.stdout;
    const timestamp = this.now().toISOString();
    this.snapshot = {
      protocolVersion: PROTOCOL_VERSION,
      agentId: job.agentId,
      name: job.name,
      status: "starting",
      cwd: job.cwd,
      startedAt: timestamp,
      updatedAt: timestamp,
      lastHeartbeatAt: timestamp,
      lastProgressAt: timestamp,
      queuedMessages: 0,
      recentActivity: [],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 },
      lastSequence: 0,
      tmuxTarget: job.tmuxTarget,
      ...(job.priority ? { priority: job.priority } : {}),
      ...(job.weight ? { weight: job.weight } : {}),
      ...(job.mutating === undefined ? {} : { mutating: job.mutating }),
      ...(job.parentCwd ? { parentCwd: job.parentCwd } : {}),
      ...(job.replaces ? { replaces: job.replaces } : {}),
      ...(job.worktree ? { worktree: job.worktree } : {}),
      ...(job.branch ? { branch: job.branch } : {}),
      ...(job.baseCommit ? { baseCommit: job.baseCommit } : {}),
      ...(job.model ? { model: job.model } : {}),
    };
  }

  get currentSnapshot(): AgentSnapshot { return structuredClone(this.snapshot); }

  async start(): Promise<void> {
    await this.store.initialize();
    await this.restoreAcknowledgements();
    await this.connect();
    await this.setStatus("idle", "RPC session ready");
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), this.options.heartbeatIntervalMs ?? 5_000);
    this.pollTimer = setInterval(() => void this.processCommands(), this.options.commandPollIntervalMs ?? 500);
    await this.processCommands();
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.heartbeatTimer = undefined;
    this.pollTimer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.transport?.close();
    this.transport = undefined;
    await this.flushEvents();
  }

  async processCommands(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      const { records } = await this.store.readCommands();
      for (const command of records) {
        if (this.acknowledged.has(command.id)) continue;
        await this.processCommand(command);
      }
    } finally {
      this.processing = false;
    }
  }

  async heartbeat(): Promise<void> {
    const timestamp = this.now().toISOString();
    this.snapshot = { ...this.snapshot, lastHeartbeatAt: timestamp, updatedAt: timestamp, pid: process.pid,
      ...(this.transport?.pid === undefined ? {} : { rpcPid: this.transport.pid }) };
    await this.emit("heartbeat", { status: this.snapshot.status });
  }

  async flushEvents(): Promise<void> {
    await this.eventQueue;
  }

  private async connect(): Promise<void> {
    this.transport = await this.createTransport();
    if (this.transport.pid !== undefined) this.snapshot = { ...this.snapshot, rpcPid: this.transport.pid, pid: process.pid };
    this.unsubscribe = this.transport.subscribe((event) => {
      renderRpcEvent(event, this.output);
      this.eventQueue = this.eventQueue.then(() => this.handleRpcEvent(event)).catch((error: unknown) => {
        process.stderr.write(`runner event error: ${(error as Error).message}\n`);
      });
    });
  }

  private async restartTransport(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.transport?.close();
    this.transport = undefined;
    this.snapshot = withoutPendingUiRequest(this.snapshot);
    await this.setStatus("starting", "Restarting RPC session");
    await this.connect();
    await this.setStatus("idle", "RPC session restarted");
  }

  private async processCommand(command: AgentCommand): Promise<void> {
    try {
      this.recordActivity("command", `${command.type} requested`);
      switch (command.type) {
        case "prompt":
        case "steer":
        case "follow_up": {
          const rpcCommand = messageCommand(command);
          if (command.type === "prompt") this.snapshot = { ...this.snapshot, task: rpcCommand.message as string };
          await this.requireTransport().send(rpcCommand);
          break;
        }
        case "abort":
          await this.setStatus("aborting", "Abort requested");
          await this.requireTransport().send({ id: command.id, type: "abort" });
          break;
        case "pause":
          this.statusBeforePause = this.snapshot.status === "paused" ? this.statusBeforePause : this.snapshot.status;
          this.requireTransport().pause();
          await this.setStatus("paused", typeof command.payload?.reason === "string" ? command.payload.reason : "Paused by parent");
          break;
        case "resume":
          this.requireTransport().resume();
          await this.setStatus(this.statusBeforePause === "paused" ? "idle" : this.statusBeforePause, "Resumed by parent");
          break;
        case "restart":
          await this.restartTransport();
          break;
        case "set_priority": {
          const priority = command.payload?.priority;
          if (!["interactive", "merge-critical", "normal", "speculative"].includes(String(priority))) throw new Error("set_priority requires a valid priority");
          this.snapshot = { ...this.snapshot, priority: priority as NonNullable<AgentSnapshot["priority"]> };
          break;
        }
        case "replace": {
          const replacementAgentId = command.payload?.replacementAgentId;
          this.snapshot = { ...this.snapshot, ...(typeof replacementAgentId === "string" ? { replacedBy: replacementAgentId } : {}) };
          await this.emitAcknowledgement(command, true);
          await this.setStatus("replaced", "Superseded by replacement agent");
          await this.stop();
          return;
        }
        case "close":
          await this.emitAcknowledgement(command, true);
          await this.setStatus("closed", "Closed by parent");
          await this.stop();
          return;
      }
      await this.emitAcknowledgement(command, true);
    } catch (error) {
      await this.emitAcknowledgement(command, false, (error as Error).message);
    }
  }

  private async handleRpcEvent(event: RpcEvent): Promise<void> {
    switch (event.type) {
      case "agent_start":
        this.snapshot = withoutPendingUiRequest(this.snapshot);
        await this.markProgress();
        await this.setStatus("running", "Agent processing");
        return;
      case "agent_settled": {
        await this.markProgress();
        this.snapshot = { ...this.snapshot, lastCompletedAt: this.now().toISOString() };
        await this.setStatus("idle", "Waiting for instructions");
        return;
      }
      case "message_update": {
        const update = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        if (update?.type === "text_delta" && update.delta) {
          await this.markProgress();
          await this.emit("message_delta", { delta: update.delta });
        }
        return;
      }
      case "message_end": {
        const message = event.message as { role?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } } | undefined;
        if (message?.role === "assistant" && message.usage) {
          this.snapshot = {
            ...this.snapshot,
            usage: {
              inputTokens: this.snapshot.usage.inputTokens + (message.usage.input ?? 0),
              outputTokens: this.snapshot.usage.outputTokens + (message.usage.output ?? 0),
              cacheReadTokens: this.snapshot.usage.cacheReadTokens + (message.usage.cacheRead ?? 0),
              cacheWriteTokens: this.snapshot.usage.cacheWriteTokens + (message.usage.cacheWrite ?? 0),
              cost: this.snapshot.usage.cost + (message.usage.cost?.total ?? 0),
            },
          };
          await this.emit("usage_changed", { usage: this.snapshot.usage });
        }
        return;
      }
      case "tool_execution_start":
        await this.markProgress();
        this.recordActivity("tool", `Started ${String(event.toolName ?? "tool")}`);
        this.snapshot = { ...this.snapshot, currentTool: String(event.toolName ?? "tool") };
        await this.emit("tool_started", { toolName: event.toolName, args: event.args });
        return;
      case "tool_execution_update":
        await this.markProgress();
        await this.emit("tool_updated", { toolName: event.toolName });
        return;
      case "tool_execution_end":
        await this.markProgress();
        this.recordActivity("tool", `${event.isError === true ? "Failed" : "Finished"} ${String(event.toolName ?? "tool")}`);
        this.snapshot = withoutCurrentTool(this.snapshot);
        await this.emit("tool_finished", { toolName: event.toolName, isError: event.isError === true });
        return;
      case "auto_retry_start":
        this.recordActivity("diagnostic", String(event.errorMessage ?? "Retrying provider request"));
        await this.setStatus("retrying", String(event.errorMessage ?? "Retrying provider request"));
        return;
      case "compaction_start":
        await this.setStatus("compacting", "Compacting context");
        return;
      case "compaction_end":
        await this.setStatus("running", "Compaction complete");
        return;
      case "queue_update": {
        const steering = Array.isArray(event.steering) ? event.steering.length : 0;
        const followUp = Array.isArray(event.followUp) ? event.followUp.length : 0;
        this.snapshot = { ...this.snapshot, queuedMessages: steering + followUp };
        await this.emit("queue_changed", { steering, followUp });
        return;
      }
      case "extension_ui_request": {
        const method = String(event.method ?? "unknown");
        const id = String(event.id ?? "unknown");
        if (["select", "confirm", "input", "editor"].includes(method)) {
          const createdAt = this.now().toISOString();
          this.snapshot = { ...this.snapshot, pendingUiRequest: { id, method, createdAt } };
          this.recordActivity("diagnostic", `Waiting for extension UI: ${method}`);
          await this.emit("diagnostic", { kind: "ui_request", id, method });
        }
        return;
      }
      case "transport_closed":
        if (!["closed", "replaced"].includes(this.snapshot.status)) await this.setStatus("orphaned", "RPC process exited");
        return;
    }
  }

  private async setStatus(status: AgentStatus, reason: string): Promise<void> {
    assertTransition(this.snapshot.status, status);
    this.snapshot = { ...this.snapshot, status, statusReason: reason };
    this.recordActivity("status", `${status}: ${reason}`);
    await this.emit("status_changed", { status, reason });
  }

  private async markProgress(): Promise<void> {
    const timestamp = this.now().toISOString();
    this.snapshot = { ...this.snapshot, lastProgressAt: timestamp, updatedAt: timestamp };
  }

  private recordActivity(kind: "status" | "tool" | "message" | "diagnostic" | "command", text: string): void {
    const activity = [...(this.snapshot.recentActivity ?? []), { at: this.now().toISOString(), kind, text }].slice(-20);
    this.snapshot = { ...this.snapshot, recentActivity: activity };
  }

  private async emitAcknowledgement(command: AgentCommand, success: boolean, error?: string): Promise<void> {
    await this.emit("command_acknowledged", { commandId: command.id, success, ...(error ? { error } : {}) }, command.id);
    this.acknowledged.add(command.id);
  }

  private async emit(type: AgentEventType, payload?: Readonly<Record<string, unknown>>, commandId?: string): Promise<void> {
    const createdAt = this.now().toISOString();
    const sequence = ++this.sequence;
    const event: AgentEvent = {
      protocolVersion: PROTOCOL_VERSION,
      id: `${this.job.agentId}-${sequence}`,
      agentId: this.job.agentId,
      sequence,
      type,
      createdAt,
      ...(commandId ? { commandId } : {}),
      ...(payload ? { payload } : {}),
    };
    this.snapshot = { ...this.snapshot, updatedAt: createdAt, lastSequence: sequence };
    await this.store.appendEvent(event);
    await this.store.writeSnapshot(this.snapshot);
  }

  private async restoreAcknowledgements(): Promise<void> {
    const { records } = await this.store.readEvents();
    for (const event of records) {
      this.sequence = Math.max(this.sequence, event.sequence);
      if (event.type === "command_acknowledged" && event.commandId) this.acknowledged.add(event.commandId);
    }
    const saved = await this.store.readSnapshot();
    if (saved) {
      const timestamp = this.now().toISOString();
      this.snapshot = { ...saved, status: "starting", statusReason: "Runner reconnecting", updatedAt: timestamp, lastHeartbeatAt: timestamp };
    }
  }

  private requireTransport(): RpcTransport {
    if (!this.transport) throw new Error("RPC transport is unavailable");
    return this.transport;
  }
}

function messageCommand(command: AgentCommand): RpcCommand {
  const message = command.payload?.message;
  if (typeof message !== "string" || message.trim().length === 0) throw new Error(`${command.type} requires payload.message`);
  return { id: command.id, type: command.type, message };
}

function withoutCurrentTool(snapshot: AgentSnapshot): AgentSnapshot {
  const { currentTool: _currentTool, ...rest } = snapshot;
  return rest;
}

function withoutPendingUiRequest(snapshot: AgentSnapshot): AgentSnapshot {
  const { pendingUiRequest: _pendingUiRequest, ...rest } = snapshot;
  return rest;
}
