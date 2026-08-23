import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAgentStateDir } from "../src/core/paths.js";
import { AgentRegistry } from "../src/core/registry.js";
import { AgentStateStore } from "../src/core/state-store.js";
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
    registry.upsert(snapshot({ agentId: launched.agentId, name: "Scout", status: "idle", currentTool: undefined, tmuxTarget: launched.tmuxTarget! }));
    await orchestrator.command(launched.agentId, "follow_up", "Run another inspection");
    const routed = await readFile(join(getAgentStateDir("parent-1", launched.agentId, agentDir), "commands.jsonl"), "utf8");
    expect(routed).toContain('"type":"prompt"');
    expect(routed).toContain("Run another inspection");
  });

  it("requires an explicit review decision before continuing settled work", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-orchestrator-review-"));
    dirs.push(agentDir);
    const run = vi.fn<CommandRunner>().mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    const registry = new AgentRegistry();
    registry.upsert(snapshot({ agentId: "review-1", status: "awaiting_review", reviewState: "pending", currentTool: undefined }));
    const orchestrator = new AgentOrchestrator("parent-review", agentDir, registry, new RunnerLauncher(new TmuxService(run)), new WorktreeService(run));
    await expect(orchestrator.command("review-1", "prompt", "Bypass it")).rejects.toThrow("awaits parent review");
    await expect(orchestrator.command("review-1", "follow_up", "Bypass it")).rejects.toThrow("awaits parent review");
    await expect(orchestrator.command("review-1", "revise", "Correct the test")).resolves.toEqual(expect.any(String));
    const commands = await readFile(join(getAgentStateDir("parent-review", "review-1", agentDir), "commands.jsonl"), "utf8");
    expect(commands).toContain('"type":"revise"');

    registry.upsert(snapshot({
      agentId: "orphan-review", status: "orphaned", reviewState: "pending", currentTool: undefined,
      latestResult: {
        resultId: "attempt-1", outcome: "completed", assignmentId: "assignment-1", attemptId: "attempt-1",
        attemptNumber: 1, completedAt: "2026-07-23T10:02:00.000Z", finalResponse: "Done",
        resultPath: "/state/assignments/assignment-1/attempts/attempt-1/result.json",
      },
    }));
    await expect(orchestrator.command("orphan-review", "dismiss")).resolves.toEqual(expect.any(String));
    const orphanCommands = await readFile(join(getAgentStateDir("parent-review", "orphan-review", agentDir), "commands.jsonl"), "utf8");
    expect(orphanCommands).toContain('"type":"dismiss"');
  });

  it("does not persist a command when missing-runner recovery fails", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-orchestrator-command-recovery-"));
    dirs.push(agentDir);
    const registry = new AgentRegistry();
    registry.upsert(snapshot({
      agentId: "missing-runner", status: "idle", currentTool: undefined, pid: 999_999,
      tmuxTarget: "pi-agents-parent-command-recovery:missing-runner",
    }));
    const run = vi.fn<CommandRunner>().mockResolvedValue({ stdout: "", stderr: "", code: 1 });
    const orchestrator = new AgentOrchestrator("parent-command-recovery", agentDir, registry, new RunnerLauncher(new TmuxService(run)), new WorktreeService(run));

    await expect(orchestrator.command("missing-runner", "steer", "Do not duplicate this")).rejects.toThrow();
    await expect(access(join(getAgentStateDir("parent-command-recovery", "missing-runner", agentDir), "commands.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recreates a missing runner from its durable job before the first snapshot", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-orchestrator-recover-"));
    dirs.push(agentDir);
    let sessionExists = false;
    const windows = new Set<string>();
    const run = vi.fn<CommandRunner>().mockImplementation(async (_command, args) => {
      if (args[0] === "has-session") return { stdout: "", stderr: "", code: sessionExists ? 0 : 1 };
      if (args[0] === "list-windows") {
        const session = String(args[2]);
        const stdout = [...windows].map((window, index) => `${session}\t${index}\t${window}\t1\t0\t1234`).join("\n");
        return { stdout: stdout ? `${stdout}\n` : "", stderr: "", code: 0 };
      }
      if (args[0] === "new-session") {
        sessionExists = true;
        windows.add(String(args[5]));
        return { stdout: "", stderr: "", code: 0 };
      }
      if (args[0] === "new-window") {
        windows.add(String(args[5]));
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });
    const registry = new AgentRegistry();
    const orchestrator = new AgentOrchestrator("parent-recover", agentDir, registry, new RunnerLauncher(new TmuxService(run)), new WorktreeService(run));
    const launched = await orchestrator.spawn({ name: "Worker", task: "Long task", cwd: agentDir, mutating: false });
    expect(registry.get(launched.agentId)).toBeUndefined();
    await expect(access(join(getAgentStateDir("parent-recover", launched.agentId, agentDir), "snapshot.json"))).rejects.toMatchObject({ code: "ENOENT" });

    sessionExists = false;
    windows.clear();
    await expect(orchestrator.recoverRunners()).resolves.toEqual({ recovered: [launched.agentId], failed: [] });
    expect(run.mock.calls.filter((call) => call[1][0] === "new-session")).toHaveLength(2);
  });

  it("dismisses a parked result when close-and-clean is requested", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-orchestrator-dismiss-review-"));
    dirs.push(agentDir);
    const registry = new AgentRegistry();
    const parked = snapshot({ agentId: "review-1", status: "awaiting_review", reviewState: "pending", currentTool: undefined });
    registry.upsert(parked);
    const store = new AgentStateStore(getAgentStateDir("parent-dismiss", parked.agentId, agentDir));
    await store.writeSnapshot(parked);
    const run = vi.fn<CommandRunner>().mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    const orchestrator = new AgentOrchestrator("parent-dismiss", agentDir, registry, new RunnerLauncher(new TmuxService(run)), new WorktreeService(run));
    const command = vi.spyOn(orchestrator, "command").mockImplementation(async (_agentId, type) => {
      expect(type).toBe("dismiss");
      await store.writeSnapshot({ ...parked, status: "closed", reviewState: "dismissed", statusReason: "Dismissed by parent" });
      return "dismiss-command";
    });

    await expect(orchestrator.closeAndClean(parked.agentId, agentDir)).resolves.toBeUndefined();
    expect(command).toHaveBeenCalledWith(parked.agentId, "dismiss");
    expect(registry.get(parked.agentId)).toBeUndefined();
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
    registry.upsert(snapshot({ agentId: replacement.agentId, name: "Worker", status: "closed", currentTool: undefined,
      cwd: launched.worktree!, worktree: launched.worktree!, branch: launched.branch!, replaces: launched.agentId }));
    await expect(orchestrator.closeAndClean(launched.agentId, agentDir)).resolves.toBeUndefined();
    expect(registry.get(launched.agentId)).toBeUndefined();
    expect(registry.get(replacement.agentId)).toBeUndefined();
    await expect(access(getAgentStateDir("parent-replace", launched.agentId, agentDir))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(getAgentStateDir("parent-replace", replacement.agentId, agentDir))).rejects.toMatchObject({ code: "ENOENT" });
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

  it("cancels queued work directly instead of writing commands with no runner", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-orchestrator-cancel-queue-"));
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
    const orchestrator = new AgentOrchestrator("parent-cancel", agentDir, registry, new RunnerLauncher(new TmuxService(run)), new WorktreeService(run), { resourceProbe });
    const queued = await orchestrator.spawn({ name: "Scout", task: "Inspect auth", cwd: agentDir, mutating: false });

    await expect(orchestrator.command(queued.agentId, "steer", "Do something else")).rejects.toThrow("requires a launched agent");
    const commandId = await orchestrator.command(queued.agentId, "abort", undefined, { reason: "No longer needed" });
    expect(await orchestrator.queueState()).toEqual([]);
    expect(registry.get(queued.agentId)).toMatchObject({ status: "closed", statusReason: "No longer needed" });
    const commands = await readFile(join(getAgentStateDir("parent-cancel", queued.agentId, agentDir), "commands.jsonl"), "utf8");
    expect(commands).toContain(commandId);
    expect(commands).toContain('"type":"abort"');

    constrained = false;
    expect(await orchestrator.drainQueue()).toBe(0);
    expect(run.mock.calls.some((call) => call[1][0] === "new-session")).toBe(false);
  });

  it("closes and cleans a queued agent without waiting for a nonexistent runner", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-orchestrator-close-queue-"));
    dirs.push(agentDir);
    const run = vi.fn<CommandRunner>().mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    const resourceProbe = { async snapshot() { return {
      cpuCount: 8, loadAverage1m: 1, totalMemoryBytes: 16 * 1024 ** 3,
      availableMemoryBytes: 256 * 1024 ** 2, availableDiskBytes: 100 * 1024 ** 3,
      activeWeight: 0, parentReservedCpu: 1, parentReservedMemoryBytes: 1024 ** 3, providerBackoff: false,
    }; } };
    const registry = new AgentRegistry();
    const orchestrator = new AgentOrchestrator("parent-close", agentDir, registry, new RunnerLauncher(new TmuxService(run)), new WorktreeService(run), { resourceProbe });
    const queued = await orchestrator.spawn({ name: "Scout", task: "Inspect auth", cwd: agentDir, mutating: false });

    await expect(orchestrator.closeAndClean(queued.agentId, agentDir)).resolves.toBeUndefined();
    expect(await orchestrator.queueState()).toEqual([]);
    expect(registry.get(queued.agentId)).toBeUndefined();
    await expect(access(getAgentStateDir("parent-close", queued.agentId, agentDir))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
