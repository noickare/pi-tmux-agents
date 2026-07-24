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

  async status(worktreePath: string): Promise<string> {
    return requireSuccess(await this.run("git", ["status", "--short", "--branch"], { cwd: worktreePath }), "read worktree status").stdout;
  }

  async remove(repoRoot: string, worktreePath: string): Promise<void> {
    requireSuccess(await this.run("git", ["worktree", "remove", worktreePath], { cwd: repoRoot }), "remove worktree");
  }
}
