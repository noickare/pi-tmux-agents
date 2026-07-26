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
  nextError: string | undefined;
  private readonly listeners = new Set<(event: RpcEvent) => void>();

  async send(command: RpcCommand): Promise<RpcResponse> {
    this.commands.push(command);
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = undefined;
      return { type: "response", command: command.type, success: false, error, ...(command.id ? { id: command.id } : {}) };
    }
    return { type: "response", command: command.type, success: true, ...(command.id ? { id: command.id } : {}) };
  }
  subscribe(listener: (event: RpcEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }
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
    transport.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Working" } });
    transport.emit({ type: "tool_execution_end", toolName: "read", isError: false });
    transport.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Implemented it and ran the targeted test." }], stopReason: "stop", usage: { input: 100, output: 20, cost: { total: 0.01 } } } });
    transport.emit({ type: "agent_settled" });
    await runner.flushEvents();

    expect(runner.currentSnapshot).toMatchObject({
      status: "awaiting_review",
      reviewState: "pending",
      task: "Implement it",
      lastSequence: 8,
      tmuxTarget: job.tmuxTarget,
      rpcPid: 4242,
      usage: { inputTokens: 100, outputTokens: 20, cost: 0.01 },
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
    await runner.processCommands();
    expect(runner.currentSnapshot).toMatchObject({ status: "closed", reviewState: "accepted" });
    const decisionEvents = (await store.readEvents()).records.filter((event) => event.commandId === "accept-1" || event.type === "status_changed");
    const closedIndex = decisionEvents.findIndex((event) => event.type === "status_changed" && event.payload?.status === "closed");
    const acknowledgementIndex = decisionEvents.findIndex((event) => event.type === "command_acknowledged" && event.commandId === "accept-1");
    expect(closedIndex).toBeGreaterThanOrEqual(0);
    expect(acknowledgementIndex).toBeGreaterThan(closedIndex);
    expect(transport.closed).toBe(true);
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
    firstTransport.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Partial work" } });
    await first.flushEvents();
    await first.stop();

    const secondTransport = new FakeTransport();
    const second = new PersistentAgentRunner(job, store, async () => secondTransport, { heartbeatIntervalMs: 60_000, commandPollIntervalMs: 60_000, output: { write() {} } });
    await second.start();
    expect(second.currentSnapshot).toMatchObject({ status: "awaiting_review", reviewState: "pending" });
    const result = await store.readResult("interrupted-assignment", "interrupted-assignment");
    expect(result).toMatchObject({ outcome: "interrupted", error: expect.stringContaining("Runner restarted") });
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

  it("does not acknowledge a rejected RPC prompt as successful", async () => {
    const { store, job } = await setup();
    await store.appendCommand(createCommand({ id: "rejected-prompt", agentId: job.agentId, type: "prompt", payload: { message: "Task" } }));
    const transport = new FakeTransport();
    transport.nextError = "model unavailable";
    const runner = new PersistentAgentRunner(job, store, async () => transport, { heartbeatIntervalMs: 60_000, commandPollIntervalMs: 60_000, output: { write() {} } });
    await runner.start();
    expect(runner.currentSnapshot).toMatchObject({ status: "idle" });
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
    await runner.stop();
  });
});
