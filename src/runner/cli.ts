#!/usr/bin/env node
import { join } from "node:path";
import { AgentStateStore } from "../core/state-store.js";
import { readAgentJob } from "./job.js";
import { buildPiRpcOptions } from "./pi-invocation.js";
import { PiRpcProcess } from "./pi-rpc-process.js";
import { PersistentAgentRunner } from "./persistent-runner.js";
import { acquireRunnerLock } from "./runner-lock.js";

const jobPath = argument("--job");
if (!jobPath) {
  process.stderr.write("Usage: pi-tmux-agent-runner --job <agent.json>\n");
  process.exitCode = 2;
} else {
  await main(jobPath);
}

async function main(path: string): Promise<void> {
  const job = await readAgentJob(path);
  const lockPath = join(job.stateDirectory, "runner.lock");
  const lock = await acquireRunnerLock(lockPath);

  const store = new AgentStateStore(job.stateDirectory);
  const runner = new PersistentAgentRunner(job, store, async () => new PiRpcProcess(await buildPiRpcOptions(job)));
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await runner.stop();
    await lock.release();
  };
  process.once("SIGINT", () => void stop().finally(() => process.exit(130)));
  process.once("SIGTERM", () => void stop().finally(() => process.exit(143)));

  try {
    process.stdout.write(`pi tmux agent: ${job.name}\nstate: ${job.stateDirectory}\nsession: ${job.sessionId}\n\n`);
    await runner.start();
  } catch (error) {
    await stop();
    throw error;
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
