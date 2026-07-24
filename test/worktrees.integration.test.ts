import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { localCommandRunner } from "../src/services/local-command-runner.js";
import { WorktreeService } from "../src/services/worktrees.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("WorktreeService integration", () => {
  it("isolates, commits, merges, and cleans an agent branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-worktree-integration-"));
    dirs.push(root);
    const repo = join(root, "repo");
    await run("git", ["init", "-b", "main", repo]);
    await run("git", ["config", "user.name", "Test"], repo);
    await run("git", ["config", "user.email", "test@example.com"], repo);
    await writeFile(join(repo, "result.txt"), "parent\n");
    await run("git", ["add", "result.txt"], repo);
    await run("git", ["commit", "-m", "initial"], repo);

    const service = new WorktreeService(localCommandRunner);
    const spec = service.derive(repo, "worker-1");
    await service.create(repo, spec);
    await writeFile(join(spec.path, "result.txt"), "child\n");
    await run("git", ["add", "result.txt"], spec.path);
    await run("git", ["commit", "-m", "agent result"], spec.path);
    await service.merge(repo, spec.branch);
    expect(await readFile(join(repo, "result.txt"), "utf8")).toBe("child\n");
    await Promise.all([service.remove(repo, spec.path), service.remove(repo, spec.path)]);
    await Promise.all([service.deleteBranch(repo, spec.branch), service.deleteBranch(repo, spec.branch)]);
    expect((await localCommandRunner("git", ["branch", "--list", spec.branch], { cwd: repo })).stdout.trim()).toBe("");
  }, 15_000);
});

async function run(command: string, args: string[], cwd?: string): Promise<void> {
  const result = await localCommandRunner(command, args, cwd ? { cwd } : undefined);
  if (result.code !== 0) throw new Error(result.stderr);
}
