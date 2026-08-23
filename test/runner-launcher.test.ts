import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandRunner } from "../src/services/command-runner.js";
import { RunnerLauncher } from "../src/services/runner-launcher.js";
import { TmuxService } from "../src/services/tmux.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("RunnerLauncher", () => {
  it("serializes concurrent first launches into one session and a second window", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-runner-launcher-parallel-"));
    directories.push(root);
    let sessionExists = false;
    const run = vi.fn<CommandRunner>().mockImplementation(async (_command, args) => {
      if (args[0] === "has-session") return { stdout: "", stderr: "", code: sessionExists ? 0 : 1 };
      if (args[0] === "new-session") {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (sessionExists) return { stdout: "", stderr: "duplicate session", code: 1 };
        sessionExists = true;
        return { stdout: "", stderr: "", code: 0 };
      }
      if (args[0] === "new-window") return { stdout: "", stderr: "", code: sessionExists ? 0 : 1 };
      return { stdout: "", stderr: "", code: 0 };
    });
    const launcher = new RunnerLauncher(new TmuxService(run));
    await Promise.all([
      launcher.launch({ parentSessionId: "parallel-parent", agentId: "worker-1", name: "Worker 1", cwd: "/repo", stateDirectory: join(root, "worker-1") }),
      launcher.launch({ parentSessionId: "parallel-parent", agentId: "worker-2", name: "Worker 2", cwd: "/repo", stateDirectory: join(root, "worker-2") }),
    ]);
    expect(run.mock.calls.filter((call) => call[1][0] === "new-session")).toHaveLength(1);
    expect(run.mock.calls.filter((call) => call[1][0] === "new-window")).toHaveLength(1);
  });

  it("does not create a duplicate window when concurrent recoveries race to recreate the session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-runner-launcher-recover-race-"));
    directories.push(directory);
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
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (sessionExists) return { stdout: "", stderr: "duplicate session", code: 1 };
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
    const initial = new RunnerLauncher(new TmuxService(run));
    const launched = await initial.launch({
      parentSessionId: "recover-race", agentId: "worker-1", name: "Worker", cwd: "/repo", stateDirectory: directory,
    });
    sessionExists = false;
    windows.clear();
    run.mockClear();

    const recovered = await Promise.all([
      new RunnerLauncher(new TmuxService(run)).recover(launched.jobPath),
      new RunnerLauncher(new TmuxService(run)).recover(launched.jobPath),
    ]);

    expect(recovered.sort()).toEqual([false, true]);
    expect(run.mock.calls.filter((call) => call[1][0] === "new-session")).toHaveLength(2);
    expect(run.mock.calls.filter((call) => call[1][0] === "new-window")).toHaveLength(0);
  });

  it("recreates a missing runner window from its durable job", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-runner-launcher-recover-"));
    directories.push(directory);
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
    const launcher = new RunnerLauncher(new TmuxService(run));
    const launched = await launcher.launch({
      parentSessionId: "recover-parent", agentId: "worker-1", name: "Worker", cwd: "/repo",
      stateDirectory: directory, prompt: "Preserve this command",
    });
    const jobBefore = await readFile(launched.jobPath, "utf8");
    const commandsBefore = await readFile(join(directory, "commands.jsonl"), "utf8");

    sessionExists = false;
    windows.clear();
    await expect(launcher.recover(launched.jobPath)).resolves.toBe(true);
    await expect(launcher.recover(launched.jobPath)).resolves.toBe(false);

    expect(await readFile(launched.jobPath, "utf8")).toBe(jobBefore);
    expect(await readFile(join(directory, "commands.jsonl"), "utf8")).toBe(commandsBefore);
    expect(run.mock.calls.filter((call) => call[1][0] === "new-session")).toHaveLength(2);
  });

  it("writes durable job/command files and launches through tmux", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-runner-launcher-"));
    directories.push(directory);
    const run = vi.fn<CommandRunner>().mockImplementation(async (_command, args) => ({
      stdout: "", stderr: "", code: args[0] === "has-session" ? 1 : 0,
    }));
    const result = await new RunnerLauncher(new TmuxService(run)).launch({
      parentSessionId: "parent-1", agentId: "worker-1", name: "Worker", cwd: "/repo",
      stateDirectory: directory, prompt: "Start here", model: "openai-codex/gpt-5.4", thinkingLevel: "high", tools: ["read"],
    });
    expect(result.job.tmuxTarget).toBe("pi-agents-parent-1:worker-1");
    expect(JSON.parse(await readFile(result.jobPath, "utf8"))).toMatchObject({
      agentId: "worker-1", model: "openai-codex/gpt-5.4", thinkingLevel: "high",
    });
    expect(await readFile(join(directory, "commands.jsonl"), "utf8")).toContain("Start here");
    const launch = run.mock.calls.find((call) => call[1][0] === "new-session");
    expect(launch?.[1]).toContain("--job");
  });
});
