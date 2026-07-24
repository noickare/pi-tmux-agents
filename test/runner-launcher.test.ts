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
  it("writes durable job/command files and launches through tmux", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-runner-launcher-"));
    directories.push(directory);
    const run = vi.fn<CommandRunner>().mockImplementation(async (_command, args) => ({
      stdout: "", stderr: "", code: args[0] === "has-session" ? 1 : 0,
    }));
    const result = await new RunnerLauncher(new TmuxService(run)).launch({
      parentSessionId: "parent-1", agentId: "worker-1", name: "Worker", cwd: "/repo",
      stateDirectory: directory, prompt: "Start here", tools: ["read"],
    });
    expect(result.job.tmuxTarget).toBe("pi-agents-parent-1:worker-1");
    expect(JSON.parse(await readFile(result.jobPath, "utf8"))).toMatchObject({ agentId: "worker-1" });
    expect(await readFile(join(directory, "commands.jsonl"), "utf8")).toContain("Start here");
    const launch = run.mock.calls.find((call) => call[1][0] === "new-session");
    expect(launch?.[1]).toContain("--job");
  });
});
