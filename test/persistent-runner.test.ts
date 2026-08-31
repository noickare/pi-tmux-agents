import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCommand, PROTOCOL_VERSION } from "../src/core/protocol.js";
import { AgentStateStore } from "../src/core/state-store.js";
import type { AgentJob } from "../src/runner/job.js";
import { PersistentAgentRunner } from "../src/runner/persistent-runner.js";
import type { RpcCommand, RpcEvent, RpcResponse, RpcTransport } from "../src/runner/rpc-types.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

class FakeTransport implements RpcTransport {
  readonly pid = 4242;
  readonly commands: RpcCommand[] = [];
  paused = false;
  closed = false;
  terminated = false;
  nextError: string | undefined;
  nextErrorType: string | undefined;
  nextThrownError: Error | undefined;
  nextThrownErrorType: string | undefined;
  clearQueueData = { steering: [] as string[], followUp: [] as string[] };
  private readonly listeners = new Set<(event: RpcEvent) => void>();

  async send(command: RpcCommand): Promise<RpcResponse> {
    this.commands.push(command);
    if (this.nextThrownError && (!this.nextThrownErrorType || this.nextThrownErrorType === command.type)) {
      const error = this.nextThrownError;
      this.nextThrownError = undefined;
      this.nextThrownErrorType = undefined;
      throw error;
    }
    if (this.nextError && (!this.nextErrorType || this.nextErrorType === command.type)) {
      const error = this.nextError;
      this.nextError = undefined;
      this.nextErrorType = undefined;
      return { type: "response", command: command.type, success: false, error, ...(command.id ? { id: command.id } : {}) };
    }
    return {
      type: "response",
      command: command.type,
      success: true,
      ...(command.type === "clear_queue" ? { data: this.clearQueueData } : {}),
      ...(command.id ? { id: command.id } : {}),
    };
  }
  subscribe(listener: (event: RpcEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }
  async terminate(): Promise<void> { this.terminated = true; this.closed = true; }
  async close(): Promise<void> { this.closed = true; }
  emit(event: RpcEvent): void { for (const listener of this.listeners) listener(event); }
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "pi-persistent-runner-"));
  directories.push(directory);
  const store = new AgentStateStore(directory);
  const job: AgentJob = {
    protocolVersion: PROTOCOL_VERSION,
    parentSessionId: "parent-1",
    agentId: "worker-1",
    name: "worker-1",
    cwd: "/repo",
    stateDirectory: directory,
    sessionId: "session-1",
    tmuxTarget: "pi-agents-parent-1:worker-1",
    approveProject: false,
  };
  return { directory, store, job };
}

describe("PersistentAgentRunner", () => {
  it("persists a result and waits for parent review after settling", async () => {
    const { store, job } = await setup();
    await store.appendCommand(createCommand({ id: "prompt-1", agentId: job.agentId, type: "prompt", payload: { message: "Implement it" } }));
    const transport = new FakeTransport();
    let transcript = "";
    const runner = new PersistentAgentRunner(job, store, async () => transport, {
      heartbeatIntervalMs: 60_000,
      commandPollIntervalMs: 60_000,
      now: () => new Date("2026-07-23T10:00:00.000Z"),
      output: { write: (text) => { transcript += text; } },
    });
    await runner.start();
    expect(transport.commands).toContainEqual({ id: "prompt-1", type: "prompt", message: "Implement it" });

    transport.emit({ type: "agent_start" });
    transport.emit({ type: "tool_execution_start", toolName: "read", args: { path: "src/index.ts" } });
    transport.emit({
      type: "message_update",
      usage: { input: 90, output: 5, cacheRead: 10, cacheWrite: 0, cost: { total: 0.004 } },
      assistantMessageEvent: { type: "text_delta", delta: "Working" },
    });
    transport.emit({ type: "tool_execution_end", toolName: "read", isError: false });
    transport.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Implemented it and ran the targeted test." }], stopReason: "stop", usage: { input: 100, output: 20, cacheRead: 10, cacheWrite: 0, cost: { total: 0.01 } } } });
    transport.emit({ type: "agent_settled" });
    await runner.flushEvents();

    expect(runner.currentSnapshot).toMatchObject({
      status: "awaiting_review",
      reviewState: "pending",
      task: "Implement it",
      lastSequence: 8,
      tmuxTarget: job.tmuxTarget,
      rpcPid: 4242,
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cost: 0.01 },
    });
    expect(transcript).toContain("→ read");
    expect(transcript).toContain("Working");
    expect(runner.currentSnapshot.latestResult).toMatchObject({ attemptNumber: 1, finalResponse: "Implemented it and ran the targeted test.", stopReason: "stop" });
    const result = await store.readResult(runner.currentSnapshot.assignmentId!, runner.currentSnapshot.attemptId!);
    expect(result).toMatchObject({ task: "Implement it", finalResponse: "Implemented it and ran the targeted test.", workspace: { cwd: "/repo" } });
    expect(transcript).toContain("awaiting parent review");
    await store.appendCommand(createCommand({ id: "close-without-decision", agentId: job.agentId, type: "close" }));
    await runner.processCommands();
    expect(runner.currentSnapshot.status).toBe("awaiting_review");
    expect((await store.readEvents()).records.at(-1)?.payload).toMatchObject({ success: false, error: expect.stringContaining("requires accept") });
    await store.appendCommand(createCommand({ id: "bypass-review", agentId: job.agentId, type: "prompt", payload: { message: "Start something else" } }));
    await runner.processCommands();
    expect(runner.currentSnapshot).toMatchObject({ status: "awaiting_review", assignmentId: "prompt-1", attemptId: "prompt-1" });
    expect((await store.readResult("prompt-1", "prompt-1"))?.finalResponse).toBe("Implemented it and ran the targeted test.");
    await runner.stop();
  });

  it("captures child reasoning summaries and responses as bounded chronological activity", async () => {
    const { store, job } = await setup();
    await store.appendCommand(createCommand({ id: "reasoning-assignment", agentId: job.agentId, type: "prompt", payload: { message: "Inspect it" } }));
    const transport = new FakeTransport();
    const runner = new PersistentAgentRunner(job, store, async () => transport, {
      heartbeatIntervalMs: 60_000,
      commandPollIntervalMs: 60_000,
      output: { write() {} },
    });
    await runner.start();
    transport.emit({ type: "agent_start" });
    transport.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } });
    transport.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Check the state boundary." } });
    transport.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "Check the state boundary." } });
    transport.emit({ type: "tool_execution_start", toolName: "read", args: { path: "src/index.ts" } });
    transport.emit({ type: "tool_execution_end", toolName: "read", isError: false });
    transport.emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 1 } });
    transport.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "The boundary is correct." } });
    transport.emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 1, content: "The boundary is correct." } });
    await runner.flushEvents();

    const visible = (runner.currentSnapshot.recentActivity ?? []).filter((event) => ["reasoning", "tool", "message"].includes(event.kind));
    expect(visible.map((event) => event.kind)).toEqual(["reasoning", "tool", "tool", "message"]);
    expect(visible[0]).toMatchObject({ text: "Check the state boundary.", state: "complete" });
    expect(visible[3]).toMatchObject({ text: "The boundary is correct.", state: "complete" });
    const eventTypes = (await store.readEvents()).records.map((event) => event.type);
    expect(eventTypes).toContain("reasoning_delta");
    expect(eventTypes).toContain("message_delta");
    await runner.stop();
  });

  it("accepts a reviewed result and stops the child", async () => {
    const { store, job } = await setup();
    await store.appendCommand(createCommand({ id: "prompt-accept", agentId: job.agentId, type: "prompt", payload: { message: "Finish it" } }));
    const transport = new FakeTransport();
    const runner = new PersistentAgentRunner(job, store, async () => transport, { heartbeatIntervalMs: 60_000, commandPollIntervalMs: 60_000, output: { write() {} } });
    await runner.start();
    transport.emit({ type: "agent_start" });
    transport.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" } });
    transport.emit({ type: "agent_settled" });
    await runner.flushEvents();
    await store.appendCommand(createCommand({ id: "accept-1", agentId: job.agentId, type: "accept" }));
    await store.appendCommand(createCommand({ id: "restart-after-accept", agentId: job.agentId, type: "restart" }));
    await runner.processCommands();
    expect(runner.currentSnapshot).toMatchObject({ status: "closed", reviewState: "accepted" });
    expect((await store.readEvents()).records.some((event) => event.commandId === "restart-after-accept")).toBe(false);
    const decisionEvents = (await store.readEvents()).records.filter((event) => event.commandId === "accept-1" || event.type === "status_changed");
    const closedIndex = decisionEvents.findIndex((event) => event.type === "status_changed" && event.payload?.status === "closed");
    const acknowledgementIndex = decisionEvents.findIndex((event) => event.type === "command_acknowledged" && event.commandId === "accept-1");
    expect(closedIndex).toBeGreaterThanOrEqual(0);
    expect(acknowledgementIndex).toBeGreaterThan(closedIndex);
    expect(transport.closed).toBe(true);
  });

  it("replays a terminal review decision after restart without starting RPC", async () => {
    const { store, job } = await setup();
    await store.appendCommand(createCommand({ id: "prompt-before-restart", agentId: job.agentId, type: "prompt", payload: { message: "Finish it" } }));
    const firstTransport = new FakeTransport();
    const first = new PersistentAgentRunner(job, store, async () => firstTransport, { heartbeatIntervalMs: 60_000, commandPollIntervalMs: 60_000, output: { write() {} } });
    await first.start();
    firstTransport.emit({ type: "agent_start" });
    firstTransport.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" } });
    firstTransport.emit({ type: "agent_settled" });
    await first.flushEvents();
    await first.stop();

    await store.appendCommand(createCommand({ id: "stale-restart", agentId: job.agentId, type: "restart" }));
    await store.appendCommand(createCommand({ id: "take-over-after-reboot", agentId: job.agentId, type: "take_over" }));
    let transportStarts = 0;
    const second = new PersistentAgentRunner(job, store, async () => {
      transportStarts++;
      throw new Error("RPC must not start for a terminal review decision");
    }, { heartbeatIntervalMs: 60_000, commandPollIntervalMs: 60_000, output: { write() {} } });
    await second.start();

    expect(transportStarts).toBe(0);
    expect(second.currentSnapshot).toMatchObject({ status: "closed", reviewState: "taken_over" });
    expect((await store.readEvents()).records.at(-1)).toMatchObject({
      type: "command_acknowledged", commandId: "take-over-after-reboot", payload: { success: true },
    });
  });

  it("keeps a settled result revisable when its RPC process exits", async () => {
    const { store, job } = await setup();
    await store.appendCommand(createCommand({ id: "prompt-before-exit", agentId: job.agentId, type: "prompt", payload: { message: "Finish it" } }));
    const first = new FakeTransport();
    const second = new FakeTransport();
    const transports = [first, second];
    const runner = new PersistentAgentRunner(job, store, async () => transports.shift()!, { heartbeatIntervalMs: 60_000, commandPollIntervalMs: 60_000, output: { write() {} } });
    await runner.start();
    first.emit({ type: "agent_start" });
    first.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" } });
    first.emit({ type: "agent_settled" });
    await runner.flushEvents();

    first.emit({ type: "transport_closed" });
    await runner.flushEvents();
    expect(runner.currentSnapshot).toMatchObject({
      status: "awaiting_review", reviewState: "pending", statusReason: "Result awaiting parent review; RPC process exited",
    });
    expect(runner.currentSnapshot.rpcPid).toBeUndefined();

    await store.appendCommand(createCommand({ id: "revise-after-exit", agentId: job.agentId, type: "revise", payload: { message: "Add the missing test" } }));
    await runner.processCommands();
    expect(second.commands).toContainEqual({ id: "revise-after-exit", type: "prompt", message: "Add the missing test" });
    expect(runner.currentSnapshot).toMatchObject({ status: "awaiting_review", reviewState: "revision_requested", attemptNumber: 2 });
    await runner.stop();
  });

  it("starts a revision attempt in the same assignment", async () => {
    const { store, job } = await setup();
    await store.appendCommand(createCommand({ id: "assignment-1", agentId: job.agentId, type: "prompt", payload: { message: "Implement it" } }));
    const transport = new FakeTransport();
    const runner = new PersistentAgentRunner(job, store, async () => transport, { heartbeatIntervalMs: 60_000, commandPollIntervalMs: 60_000, output: { write() {} } });
    await runner.start();
    transport.emit({ type: "agent_start" });
    transport.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "First result" }] } });
    transport.emit({ type: "agent_settled" });
    await runner.flushEvents();
    await store.appendCommand(createCommand({ id: "attempt-2", agentId: job.agentId, type: "revise", payload: { message: "Fix the failing test" } }));
    await runner.processCommands();
    expect(transport.commands.at(-1)).toEqual({ id: "attempt-2", type: "prompt", message: "Fix the failing test" });
    expect(runner.currentSnapshot).toMatchObject({ assignmentId: "assignment-1", attemptId: "attempt-2", attemptNumber: 2, reviewState: "revision_requested" });
    transport.emit({ type: "agent_start" });
    transport.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Revised result" }] } });
    transport.emit({ type: "agent_settled" });
    await runner.flushEvents();
    expect(await store.readResult("assignment-1", "assignment-1")).toMatchObject({ finalResponse: "First result", attemptNumber: 1 });
    expect(await store.readResult("assignment-1", "attempt-2")).toMatchObject({ task: "Implement it", finalResponse: "Revised result", attemptNumber: 2 });
    await runner.stop();
  });

  it("publishes interrupted active work for parent review after runner restart", async () => {
    const { store, job } = await setup();
    await store.appendCommand(createCommand({ id: "interrupted-assignment", agentId: job.agentId, type: "prompt", payload: { message: "Long task" } }));
    const firstTransport = new FakeTransport();
    const first = new PersistentAgentRunner(job, store, async () => firstTransport, { heartbeatIntervalMs: 60_000, commandPollIntervalMs: 60_000, output: { write() {} } });
    await first.start();
    firstTransport.emit({ type: "agent_start" });
    firstTransport.emit({
      type: "message_update",
      usage: { input: 120, output: 8, cacheRead: 40, cacheWrite: 3, cost: { total: 0.02 } },
      assistantMessageEvent: { type: "text_delta", delta: "Partial work" },
    });
    await first.flushEvents();
    await first.stop();

    const secondTransport = new FakeTransport();
    const second = new PersistentAgentRunner(job, store, async () => secondTransport, { heartbeatIntervalMs: 60_000, commandPollIntervalMs: 60_000, output: { write() {} } });
    await second.start();
    expect(second.currentSnapshot).toMatchObject({ status: "awaiting_review", reviewState: "pending" });
    const result = await store.readResult("interrupted-assignment", "interrupted-assignment");
    expect(result).toMatchObject({
      outcome: "interrupted",
      error: expect.stringContaining("Runner restarted"),
      usage: { inputTokens: 120, outputTokens: 8, cacheReadTokens: 40, cacheWriteTokens: 3, cost: 0.02 },
    });
    await second.stop();
  });

  it("recovers a result written before its snapshot publication", async () => {
    const { store, job } = await setup();
    await store.appendCommand(createCommand({ id: "recover-assignment", agentId: job.agentId, type: "prompt", payload: { message: "Task" } }));
    const firstTransport = new FakeTransport();
    const first = new PersistentAgentRunner(job, store, async () => firstTransport, { heartbeatIntervalMs: 60_000, commandPollIntervalMs: 60_000, output: { write() {} } });
    await first.start();
    firstTransport.emit({ type: "agent_start" });
    firstTransport.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Durable result" }] } });
    firstTransport.emit({ type: "agent_settled" });
    await first.flushEvents();
    const published = first.currentSnapshot;
    await first.stop();
    const { latestResult: _latestResult, reviewState: _reviewState, ...withoutPublication } = published;
    await new AgentStateStore(job.stateDirectory).writeSnapshot({ ...withoutPublication, status: "running", statusReason: "simulated crash window", lastSequence: published.lastSequence + 1 });

    const second = new PersistentAgentRunner(job, store, async () => new FakeTransport(), { heartbeatIntervalMs: 60_000, commandPollIntervalMs: 60_000, output: { write() {} } });
    await second.start();
    expect(second.currentSnapshot).toMatchObject({ status: "awaiting_review", latestResult: { finalResponse: "Durable result", outcome: "completed" } });
    await second.stop();
  });

  it("tracks same-run compaction between a large tool result and the next assistant response", async () => {
    const { store, job } = await setup();
    await store.appendCommand(createCommand({ id: "compact-assignment", agentId: job.agentId, type: "prompt", payload: { message: "Produce a large result" } }));
    const transport = new FakeTransport();
    const runner = new PersistentAgentRunner(job, store, async () => transport, {
      heartbeatIntervalMs: 60_000, commandPollIntervalMs: 60_000, output: { write() {} },
    });
    await runner.start();

    transport.emit({ type: "agent_start" });
    transport.emit({ type: "tool_execution_start", toolName: "bash", args: { command: "large-output" } });
    transport.emit({ type: "tool_execution_end", toolName: "bash", isError: false });
    transport.emit({ type: "compaction_start", reason: "threshold" });
    transport.emit({ type: "compaction_end", reason: "threshold", result: { summary: "Compacted" }, aborted: false, willRetry: false });
    transport.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Continued after compaction" }], stopReason: "stop" } });
    transport.emit({ type: "agent_settled" });
    await runner.flushEvents();

    expect(runner.currentSnapshot).toMatchObject({
      status: "awaiting_review",
      latestResult: { outcome: "completed", finalResponse: "Continued after compaction" },
    });
    const reasons = (await store.readEvents()).records
      .filter((event) => event.type === "status_changed")
      .map((event) => event.payload?.reason);
    expect(reasons).toEqual(expect.arrayContaining(["Compacting context", "Compaction complete"]));
    await runner.stop();
  });

  it("keeps abort authoritative when compaction ends as aborted", async () => {
    const { store, job } = await setup();
    await store.appendCommand(createCommand({ id: "compact-abort-assignment", agentId: job.agentId, type: "prompt", payload: { message: "Long compacting task" } }));
    const transport = new FakeTransport();
    transport.clearQueueData = { steering: ["queued correction"], followUp: ["queued follow-up"] };
    const runner = new PersistentAgentRunner(job, store, async () => transport, {
      heartbeatIntervalMs: 60_000, commandPollIntervalMs: 60_000, output: { write() {} },
    });
    await runner.start();
    transport.emit({ type: "agent_start" });
    transport.emit({ type: "queue_update", steering: ["queued correction"], followUp: ["queued follow-up"] });
    transport.emit({ type: "compaction_start", reason: "threshold" });
    await runner.flushEvents();

    await store.appendCommand(createCommand({ id: "abort-during-compaction", agentId: job.agentId, type: "abort" }));
    await runner.processCommands();
    expect(transport.commands.slice(-2)).toEqual([
      { type: "clear_queue" },
      { id: "abort-during-compaction", type: "abort" },
    ]);
    expect(runner.currentSnapshot).toMatchObject({ status: "aborting", queuedMessages: 0 });

    transport.emit({ type: "compaction_end", reason: "threshold", result: null, aborted: true, willRetry: false });
    transport.emit({ type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted" } });
    transport.emit({ type: "agent_settled" });
    await runner.flushEvents();
    expect(runner.currentSnapshot).toMatchObject({
      status: "awaiting_review",
      latestResult: { outcome: "interrupted", error: "Agent operation aborted by parent" },
    });
    expect(runner.currentSnapshot.recentActivity?.some((item) => item.text === "Compaction aborted")).toBe(true);
    await runner.stop();
  });

  it("reports a failed compaction before the run settles", async () => {
    const { store, job } = await setup();
    await store.appendCommand(createCommand({ id: "compact-failure-assignment", agentId: job.agentId, type: "prompt", payload: { message: "Compacting task" } }));
    const transport = new FakeTransport();
    const runner = new PersistentAgentRunner(job, store, async () => transport, {
      heartbeatIntervalMs: 60_000, commandPollIntervalMs: 60_000, output: { write() {} },
    });
    await runner.start();
    transport.emit({ type: "agent_start" });
    transport.emit({ type: "compaction_start", reason: "threshold" });
    transport.emit({ type: "compaction_end", reason: "threshold", result: null, aborted: false, errorMessage: "summary unavailable", willRetry: false });
    await runner.flushEvents();
    expect(runner.currentSnapshot).toMatchObject({ status: "running", statusReason: "Compaction failed: summary unavailable" });
    await runner.stop();
  });

  it("clears queued messages before aborting an active child", async () => {
    const { store, job } = await setup();
    await store.appendCommand(createCommand({ id: "clear-before-abort-assignment", agentId: job.agentId, type: "prompt", payload: { message: "Long task" } }));
    const transport = new FakeTransport();
    transport.clearQueueData = { steering: ["change direction"], followUp: ["summarize later"] };
    const runner = new PersistentAgentRunner(job, store, async () => transport, {
      heartbeatIntervalMs: 60_000, commandPollIntervalMs: 60_000, output: { write() {} },
    });
    await runner.start();
    transport.emit({ type: "agent_start" });
    transport.emit({ type: "queue_update", steering: ["change direction"], followUp: ["summarize later"] });
    await runner.flushEvents();
    expect(runner.currentSnapshot.queuedMessages).toBe(2);

    await store.appendCommand(createCommand({ id: "abort-after-clear", agentId: job.agentId, type: "abort" }));
    await runner.processCommands();

    expect(transport.commands.slice(-2)).toEqual([
      { type: "clear_queue" },
      { id: "abort-after-clear", type: "abort" },
    ]);
    expect(runner.currentSnapshot).toMatchObject({ status: "aborting", queuedMessages: 0 });
    expect(runner.currentSnapshot.recentActivity?.some((item) => item.text === "Cleared 2 queued messages before abort")).toBe(true);
    await runner.stop();
  });

  it("force-restarts without aborting when queue clearing fails", async () => {
    const { store, job } = await setup();
    await store.appendCommand(createCommand({ id: "clear-failure-assignment", agentId: job.agentId, type: "prompt", payload: { message: "Long task" } }));
    const first = new FakeTransport();
    const second = new FakeTransport();
    const transports = [first, second];
    const runner = new PersistentAgentRunner(job, store, async () => transports.shift()!, {
      heartbeatIntervalMs: 60_000, commandPollIntervalMs: 60_000, output: { write() {} },
    });
    await runner.start();
    first.emit({ type: "agent_start" });
    first.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Partial work" } });
    await runner.flushEvents();
    first.nextThrownError = new Error("RPC command timed out: clear_queue");
    first.nextThrownErrorType = "clear_queue";

    await store.appendCommand(createCommand({ id: "abort-after-clear-failure", agentId: job.agentId, type: "abort" }));
    await runner.processCommands();

    expect(first.terminated).toBe(true);
    expect(first.commands.at(-1)).toEqual({ type: "clear_queue" });
    expect(first.commands.some((command) => command.type === "abort")).toBe(false);
    expect(runner.currentSnapshot).toMatchObject({
      status: "awaiting_review",
      queuedMessages: 0,
      latestResult: { outcome: "interrupted", error: expect.stringContaining("queue clearing failed") },
    });
    expect((await store.readEvents()).records.at(-1)).toMatchObject({
      type: "command_acknowledged", commandId: "abort-after-clear-failure", payload: { success: true },
    });
    await runner.stop();
  });

  it("records an aborted settled run as interrupted", async () => {
    const { store, job } = await setup();
    await store.appendCommand(createCommand({ id: "abort-result", agentId: job.agentId, type: "prompt", payload: { message: "Long task" } }));
    const transport = new FakeTransport();
    const runner = new PersistentAgentRunner(job, store, async () => transport, { heartbeatIntervalMs: 60_000, commandPollIntervalMs: 60_000, output: { write() {} } });
    await runner.start();
    transport.emit({ type: "agent_start" });
    transport.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Partial work" } });
    transport.emit({ type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted" } });
    transport.emit({ type: "agent_settled" });
    await runner.flushEvents();
    expect(runner.currentSnapshot).toMatchObject({ status: "awaiting_review", latestResult: { outcome: "interrupted", error: "Agent operation aborted by parent" } });
    await runner.stop();
  });

  it("force-restarts RPC after graceful abort fails and keeps the child revisable", async () => {
    const { store, job } = await setup();
    await store.appendCommand(createCommand({ id: "abort-timeout", agentId: job.agentId, type: "prompt", payload: { message: "Long task" } }));
    const first = new FakeTransport();
    const second = new FakeTransport();
    const transports = [first, second];
    const runner = new PersistentAgentRunner(job, store, async () => transports.shift()!, { heartbeatIntervalMs: 60_000, commandPollIntervalMs: 60_000, output: { write() {} } });
    await runner.start();
    first.emit({ type: "agent_start" });
    first.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Partial work" } });
    await runner.flushEvents();
    first.nextThrownError = new Error("RPC command timed out: abort");
    first.nextThrownErrorType = "abort";
    await store.appendCommand(createCommand({ id: "abort-command", agentId: job.agentId, type: "abort" }));
    await runner.processCommands();

    expect(first.terminated).toBe(true);
    expect(first.commands.slice(-2)).toEqual([
      { type: "clear_queue" },
      { id: "abort-command", type: "abort" },
    ]);
    expect(runner.currentSnapshot).toMatchObject({
      status: "awaiting_review",
      latestResult: { outcome: "interrupted", error: expect.stringContaining("graceful abort failed") },
    });
    expect((await store.readEvents()).records.at(-1)).toMatchObject({ type: "command_acknowledged", commandId: "abort-command", payload: { success: true } });

    await store.appendCommand(createCommand({ id: "revision", agentId: job.agentId, type: "revise", payload: { message: "Finish concisely" } }));
    await runner.processCommands();
    expect(second.commands).toContainEqual({ id: "revision", type: "prompt", message: "Finish concisely" });
    await runner.stop();
  });

  it("does not acknowledge a rejected RPC prompt as successful", async () => {
    const { store, job } = await setup();
    await store.appendCommand(createCommand({ id: "rejected-prompt", agentId: job.agentId, type: "prompt", payload: { message: "Task" } }));
    const transport = new FakeTransport();
    transport.nextError = "model unavailable";
    const runner = new PersistentAgentRunner(job, store, async () => transport, { heartbeatIntervalMs: 60_000, commandPollIntervalMs: 60_000, output: { write() {} } });
    await runner.start();
    expect(runner.currentSnapshot).toMatchObject({ status: "failed", statusReason: "Prompt rejected: model unavailable" });
    expect(runner.currentSnapshot.assignmentId).toBeUndefined();
    expect((await store.readEvents()).records.at(-1)).toMatchObject({
      type: "command_acknowledged",
      commandId: "rejected-prompt",
      payload: { success: false, error: "model unavailable" },
    });
    await runner.stop();
  });

  it("does not replay acknowledged commands after runner restart", async () => {
    const { store, job } = await setup();
    await store.appendCommand(createCommand({ id: "steer-1", agentId: job.agentId, type: "steer", payload: { message: "Focus" } }));
    const firstTransport = new FakeTransport();
    const first = new PersistentAgentRunner(job, store, async () => firstTransport, { heartbeatIntervalMs: 60_000, commandPollIntervalMs: 60_000 });
    await first.start();
    await first.stop();

    const secondTransport = new FakeTransport();
    const second = new PersistentAgentRunner(job, store, async () => secondTransport, { heartbeatIntervalMs: 60_000, commandPollIntervalMs: 60_000 });
    await second.start();
    expect(secondTransport.commands.filter((command) => command.type === "steer")).toHaveLength(0);
    await second.stop();
  });

  it("clears active tool state when closed during execution", async () => {
    const { store, job } = await setup();
    const transport = new FakeTransport();
    const runner = new PersistentAgentRunner(job, store, async () => transport, {
      heartbeatIntervalMs: 60_000, commandPollIntervalMs: 60_000, output: { write() {} },
    });
    await runner.start();
    transport.emit({ type: "agent_start" });
    transport.emit({ type: "tool_execution_start", toolName: "bash" });
    await runner.flushEvents();
    await store.appendCommand(createCommand({ id: "close-running", agentId: job.agentId, type: "close" }));
    await runner.processCommands();
    expect(runner.currentSnapshot.status).toBe("closed");
    expect(runner.currentSnapshot.currentTool).toBeUndefined();
  });

  it("pauses and resumes without losing the prior state", async () => {
    const { store, job } = await setup();
    await store.appendCommand(createCommand({ id: "pause-1", agentId: job.agentId, type: "pause" }));
    await store.appendCommand(createCommand({ id: "resume-1", agentId: job.agentId, type: "resume" }));
    const transport = new FakeTransport();
    const runner = new PersistentAgentRunner(job, store, async () => transport, { heartbeatIntervalMs: 60_000, commandPollIntervalMs: 60_000 });
    await runner.start();
    expect(transport.paused).toBe(false);
    expect(runner.currentSnapshot.status).toBe("idle");
    const activityIds = (runner.currentSnapshot.recentActivity ?? []).map((activity) => activity.id);
    expect(activityIds.every((id) => id !== undefined)).toBe(true);
    expect(new Set(activityIds).size).toBe(activityIds.length);
    await runner.stop();
  });
});
