import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommand } from "../src/core/protocol.js";
import { AgentStateStore } from "../src/core/state-store.js";
import { localCommandRunner } from "../src/services/local-command-runner.js";
import { RunnerLauncher } from "../src/services/runner-launcher.js";
import { TmuxService } from "../src/services/tmux.js";

const parentSessionId = `smoke-${process.pid}`;
const agentId = "worker-1";
const session = `pi-agents-${parentSessionId}`;
const stateDirectory = await mkdtemp(join(tmpdir(), "pi-tmux-runner-smoke-"));
const tmux = new TmuxService(localCommandRunner);
const store = new AgentStateStore(stateDirectory);

try {
  const launched = await new RunnerLauncher(tmux).launch({
    parentSessionId,
    agentId,
    name: "Smoke Worker",
    cwd: process.cwd(),
    stateDirectory,
  });
  const ready = await waitFor(async () => {
    const snapshot = await store.readSnapshot();
    return snapshot?.status === "idle" ? snapshot : undefined;
  }, 15_000);
  console.log(`ready: ${ready.tmuxTarget} rpc=${ready.rpcPid ?? "unknown"}`);

  await store.appendCommand(createCommand({ id: randomUUID(), agentId, type: "close" }));
  const closed = await waitFor(async () => {
    const snapshot = await store.readSnapshot();
    return snapshot?.status === "closed" ? snapshot : undefined;
  }, 10_000);
  console.log(`closed: sequence=${closed.lastSequence} session=${launched.job.sessionId}`);
} finally {
  if (await tmux.hasSession(session)) await localCommandRunner("tmux", ["kill-session", "-t", session]);
  await rm(stateDirectory, { recursive: true, force: true });
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}
