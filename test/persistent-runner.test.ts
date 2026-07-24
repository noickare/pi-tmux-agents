import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCommand } from "../src/core/protocol.js";
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
  private readonly listeners = new Set<(event: RpcEvent) => void>();

  async send(command: RpcCommand): Promise<RpcResponse> {
    this.commands.push(command);
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
    protocolVersion: 1,
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
  it("processes a prompt, streams progress, and becomes idle again", async () => {
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
    transport.emit({ type: "message_end", message: { role: "assistant", usage: { input: 100, output: 20, cost: { total: 0.01 } } } });
    transport.emit({ type: "agent_settled" });
    await runner.flushEvents();

    expect(runner.currentSnapshot).toMatchObject({
      status: "idle",
      task: "Implement it",
      lastSequence: 8,
      tmuxTarget: job.tmuxTarget,
      rpcPid: 4242,
      usage: { inputTokens: 100, outputTokens: 20, cost: 0.01 },
    });
    expect(transcript).toContain("→ read");
    expect(transcript).toContain("Working");
    expect(transcript).toContain("agent idle");
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
