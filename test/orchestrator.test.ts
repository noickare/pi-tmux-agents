import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAgentStateDir } from "../src/core/paths.js";
import { AgentRegistry } from "../src/core/registry.js";
import type { CommandRunner } from "../src/services/command-runner.js";
import { AgentOrchestrator } from "../src/services/orchestrator.js";
import { RunnerLauncher } from "../src/services/runner-launcher.js";
import { TmuxService } from "../src/services/tmux.js";
import { WorktreeService } from "../src/services/worktrees.js";
import { snapshot } from "./fixtures.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("AgentOrchestrator", () => {
  it("launches an agent and persists later steering commands", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-orchestrator-"));
    dirs.push(agentDir);
    const run = vi.fn<CommandRunner>().mockImplementation(async (_command, args) => ({ stdout: "", stderr: "", code: args[0] === "has-session" ? 1 : 0 }));
    const registry = new AgentRegistry();
    const orchestrator = new AgentOrchestrator("parent-1", agentDir, registry, new RunnerLauncher(new TmuxService(run)), new WorktreeService(run));
    const launched = await orchestrator.spawn({ name: "Scout", task: "Inspect auth", cwd: agentDir, mutating: false });
    expect(launched.queued).toBe(false);
    expect(launched.tmuxTarget).toBeDefined();
    registry.upsert(snapshot({ agentId: launched.agentId, name: "Scout", tmuxTarget: launched.tmuxTarget! }));
    const commandId = await orchestrator.command(launched.agentId, "steer", "Focus on middleware");
    const commands = await readFile(join(getAgentStateDir("parent-1", launched.agentId, agentDir), "commands.jsonl"), "utf8");
    expect(commands).toContain(commandId);
    expect(commands).toContain("Focus on middleware");
  });

  it("durably queues constrained work and admits it when resources recover", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-orchestrator-queue-"));
    dirs.push(agentDir);
    const run = vi.fn<CommandRunner>().mockImplementation(async (_command, args) => ({ stdout: "", stderr: "", code: args[0] === "has-session" ? 1 : 0 }));
    let constrained = true;
    const resourceProbe = {
      async snapshot() {
        return {
          cpuCount: 8, loadAverage1m: 1, totalMemoryBytes: 16 * 1024 ** 3,
          availableMemoryBytes: constrained ? 256 * 1024 ** 2 : 12 * 1024 ** 3,
          availableDiskBytes: 100 * 1024 ** 3, activeWeight: 0,
          parentReservedCpu: 1, parentReservedMemoryBytes: 1024 ** 3, providerBackoff: false,
        };
      },
    };
    const registry = new AgentRegistry();
    const orchestrator = new AgentOrchestrator("parent-2", agentDir, registry, new RunnerLauncher(new TmuxService(run)), new WorktreeService(run), { resourceProbe });
    const queued = await orchestrator.spawn({ name: "Scout", task: "Inspect auth", cwd: agentDir, mutating: false });
    expect(queued).toMatchObject({ queued: true, queueReason: "critical memory pressure" });
    constrained = false;
    expect(await orchestrator.drainQueue()).toBe(1);
    expect(run.mock.calls.some((call) => call[1][0] === "new-session")).toBe(true);
  });
});
