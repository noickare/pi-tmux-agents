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

  it("replaces an orphaned agent while preserving its worktree and branch", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-orchestrator-replace-"));
    dirs.push(agentDir);
    const run = vi.fn<CommandRunner>().mockImplementation(async (command, args) => {
      if (command === "git" && args[0] === "rev-parse") return { stdout: "abc123\n", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: command === "tmux" && args[0] === "has-session" ? 1 : 0 };
    });
    const registry = new AgentRegistry();
    const orchestrator = new AgentOrchestrator("parent-replace", agentDir, registry, new RunnerLauncher(new TmuxService(run)), new WorktreeService(run));
    const launched = await orchestrator.spawn({ name: "Worker", task: "Implement feature", cwd: agentDir, mutating: true });
    registry.upsert(snapshot({
      agentId: launched.agentId, name: "Worker", status: "orphaned", task: "Implement feature",
      cwd: launched.worktree!, parentCwd: agentDir, worktree: launched.worktree!, branch: launched.branch!, baseCommit: "abc123",
    }));
    const replacement = await orchestrator.replace(launched.agentId, "runner disappeared");
    expect(replacement).toMatchObject({ queued: false, worktree: launched.worktree, branch: launched.branch, replaces: launched.agentId });
    const replacementJob = JSON.parse(await readFile(join(getAgentStateDir("parent-replace", replacement.agentId, agentDir), "agent.json"), "utf8"));
    expect(replacementJob).toMatchObject({ worktree: launched.worktree, branch: launched.branch, replaces: launched.agentId });
    await expect(orchestrator.closeAndClean(launched.agentId, agentDir)).rejects.toThrow(`handed to ${replacement.agentId}`);
  });

  it("auto-pauses low-priority work under critical pressure and resumes after recovery", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-orchestrator-rebalance-"));
    dirs.push(agentDir);
    let critical = true;
    const resourceProbe = { async snapshot() { return {
      cpuCount: 8, loadAverage1m: 1, totalMemoryBytes: 16 * 1024 ** 3,
      availableMemoryBytes: critical ? 256 * 1024 ** 2 : 12 * 1024 ** 3,
      availableDiskBytes: 100 * 1024 ** 3, activeWeight: 1,
      parentReservedCpu: 1, parentReservedMemoryBytes: 1024 ** 3, providerBackoff: false,
    }; } };
    const registry = new AgentRegistry();
    registry.upsert(snapshot({ agentId: "spec-1", status: "running", priority: "speculative" }));
    const run = vi.fn<CommandRunner>().mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    const orchestrator = new AgentOrchestrator("parent-balance", agentDir, registry, new RunnerLauncher(new TmuxService(run)), new WorktreeService(run), { resourceProbe, resourceRecoveryStableMs: 0 });
    expect((await orchestrator.rebalance(agentDir))?.paused).toEqual(["spec-1"]);
    expect((await orchestrator.rebalance(agentDir))?.paused).toEqual([]);
    registry.upsert(snapshot({ agentId: "spec-1", status: "paused", statusReason: "Auto-paused under critical resource pressure", priority: "speculative" }));
    critical = false;
    expect((await orchestrator.rebalance(agentDir))?.resumed).toEqual(["spec-1"]);
    expect((await orchestrator.rebalance(agentDir))?.resumed).toEqual([]);
    const commands = await readFile(join(getAgentStateDir("parent-balance", "spec-1", agentDir), "commands.jsonl"), "utf8");
    expect(commands).toContain('"type":"pause"');
    expect(commands).toContain('"type":"resume"');
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
