import { basename, dirname, join, resolve } from "node:path";
import { assertSafeId } from "../core/paths.js";
import type { CommandRunner } from "./command-runner.js";
import { requireSuccess } from "./command-runner.js";

export interface WorktreeSpec {
  path: string;
  branch: string;
  base: string;
}

export class WorktreeService {
  constructor(private readonly run: CommandRunner) {}

  derive(repoRoot: string, agentId: string, base = "HEAD"): WorktreeSpec {
    const safeId = assertSafeId(agentId, "agent id");
    const main = resolve(repoRoot);
    const root = join(dirname(main), ".worktrees");
    return { path: join(root, safeId), branch: `agent/${safeId}`, base };
  }

  async create(repoRoot: string, spec: WorktreeSpec): Promise<void> {
    if (!spec.branch.startsWith("agent/")) throw new Error(`Invalid agent branch: ${spec.branch}`);
    requireSuccess(await this.run("git", ["worktree", "add", "-b", spec.branch, spec.path, spec.base], { cwd: repoRoot }),
      `create worktree ${basename(spec.path)}`);
  }

  async currentCommit(path: string): Promise<string> {
    return requireSuccess(await this.run("git", ["rev-parse", "HEAD"], { cwd: path }), "read Git commit").stdout.trim();
  }

  async status(worktreePath: string): Promise<string> {
    return requireSuccess(await this.run("git", ["status", "--short", "--branch"], { cwd: worktreePath }), "read worktree status").stdout;
  }

  async diff(worktreePath: string, base = "HEAD"): Promise<string> {
    return requireSuccess(await this.run("git", ["diff", "--no-ext-diff", base, "--", "."], { cwd: worktreePath }), "read worktree diff").stdout;
  }

  async validate(worktreePath: string, command: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const [executable, ...args] = command;
    if (!executable) throw new Error("Validation requires an executable and optional arguments");
    return this.run(executable, args, { cwd: worktreePath, timeout: 30 * 60_000 });
  }

  async isValid(worktreePath: string, expectedBranch?: string): Promise<{ valid: boolean; detail: string }> {
    const result = await this.run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath });
    if (result.code !== 0) return { valid: false, detail: result.stderr.trim() || "not a Git worktree" };
    const branch = result.stdout.trim();
    return expectedBranch && branch !== expectedBranch
      ? { valid: false, detail: `expected ${expectedBranch}, found ${branch}` }
      : { valid: true, detail: branch };
  }

  async merge(repoRoot: string, branch: string): Promise<void> {
    if (!branch.startsWith("agent/")) throw new Error(`Invalid agent branch: ${branch}`);
    requireSuccess(await this.run("git", ["merge", "--no-edit", branch], { cwd: repoRoot }), `merge ${branch}`);
  }

  async remove(repoRoot: string, worktreePath: string, force = false): Promise<void> {
    requireSuccess(await this.run("git", ["worktree", "remove", ...(force ? ["--force"] : []), worktreePath], { cwd: repoRoot }), "remove worktree");
  }

  async deleteBranch(repoRoot: string, branch: string, force = false): Promise<void> {
    if (!branch.startsWith("agent/")) throw new Error(`Invalid agent branch: ${branch}`);
    requireSuccess(await this.run("git", ["branch", force ? "-D" : "-d", branch], { cwd: repoRoot }), `delete ${branch}`);
  }
}
