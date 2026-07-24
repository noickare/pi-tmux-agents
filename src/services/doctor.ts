import { access, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CommandRunner } from "./command-runner.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  remediation?: string;
}

export class AgentsDoctor {
  constructor(private readonly run: CommandRunner) {}

  async check(stateRoot: string): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    checks.push(await this.version("tmux", ["-V"], "tmux", 3, 2, installTmuxCommand()));
    checks.push(await this.version("git", ["--version"], "git", 2, 20, "Install Git 2.20 or newer using your system package manager."));
    checks.push(nodeVersionCheck());
    checks.push(await writableDirectory(stateRoot));
    checks.push(await this.tmuxConnectivity());
    checks.push(await this.tmuxOption("extended-keys", "on", "Add `set -g extended-keys on` to ~/.tmux.conf."));
    if (versionAtLeast(checks[0]?.detail ?? "", 3, 5)) {
      checks.push(await this.tmuxOption("extended-keys-format", "csi-u", "Add `set -g extended-keys-format csi-u` to ~/.tmux.conf."));
    }
    checks.push(await this.resourceProbe(stateRoot));
    checks.push(await this.worktreeProbe());
    checks.push(await this.staleSessions(stateRoot));
    return checks;
  }

  private async version(command: string, args: string[], name: string, major: number, minor: number, remediation: string): Promise<DoctorCheck> {
    const result = await this.run(command, args, { timeout: 5_000 });
    const detail = (result.stdout || result.stderr).trim();
    return result.code === 0 && versionAtLeast(detail, major, minor)
      ? { name, ok: true, detail }
      : { name, ok: false, detail: detail || "not available", remediation };
  }

  private async tmuxConnectivity(): Promise<DoctorCheck> {
    const session = `pi-agents-doctor-${process.pid}-${Date.now()}`;
    const created = await this.run("tmux", ["new-session", "-d", "-s", session, "sleep", "5"], { timeout: 5_000 });
    if (created.code !== 0) return { name: "tmux connectivity", ok: false, detail: created.stderr.trim(), remediation: "Check tmux server permissions and socket configuration." };
    const visible = await this.run("tmux", ["has-session", "-t", session], { timeout: 5_000 });
    await this.run("tmux", ["kill-session", "-t", session], { timeout: 5_000 });
    return visible.code === 0
      ? { name: "tmux connectivity", ok: true, detail: "session create/list/cleanup succeeded" }
      : { name: "tmux connectivity", ok: false, detail: visible.stderr.trim() || "temporary session was not visible" };
  }

  private async tmuxOption(option: string, expected: string, remediation: string): Promise<DoctorCheck> {
    const result = await this.run("tmux", ["show-options", "-gqv", option], { timeout: 5_000 });
    const actual = result.stdout.trim();
    return actual === expected
      ? { name: `tmux ${option}`, ok: true, detail: actual }
      : { name: `tmux ${option}`, ok: false, detail: actual || "not configured", remediation };
  }

  private async resourceProbe(stateRoot: string): Promise<DoctorCheck> {
    const [disk, processes] = await Promise.all([
      this.run("df", ["-Pk", stateRoot], { timeout: 5_000 }),
      this.run("ps", ["-axo", "pid=,command="], { timeout: 5_000 }),
    ]);
    const memory = process.memoryUsage().rss;
    const ok = disk.code === 0 && processes.code === 0 && memory > 0;
    return ok
      ? { name: "resource probes", ok: true, detail: "disk, process, CPU, and memory probes available" }
      : { name: "resource probes", ok: false, detail: disk.stderr.trim() || processes.stderr.trim() || "memory probe failed", remediation: "Ensure df and ps are available in PATH." };
  }

  private async worktreeProbe(): Promise<DoctorCheck> {
    const root = await mkdtemp(join(tmpdir(), "pi-agents-doctor-git-"));
    const repo = join(root, "repo");
    const worktree = join(root, "worktree");
    try {
      await mkdir(repo);
      const commands: Array<[string, string[], string]> = [
        ["git", ["init", "-b", "main"], repo],
        ["git", ["config", "user.name", "pi-tmux-agents doctor"], repo],
        ["git", ["config", "user.email", "doctor@localhost"], repo],
      ];
      for (const [command, args, cwd] of commands) {
        const result = await this.run(command, args, { cwd, timeout: 5_000 });
        if (result.code !== 0) throw new Error(result.stderr.trim());
      }
      await writeFile(join(repo, "probe.txt"), "probe\n");
      for (const args of [["add", "probe.txt"], ["commit", "-m", "doctor probe"]]) {
        const result = await this.run("git", args, { cwd: repo, timeout: 5_000 });
        if (result.code !== 0) throw new Error(result.stderr.trim());
      }
      const add = await this.run("git", ["worktree", "add", "-b", "doctor/probe", worktree], { cwd: repo, timeout: 10_000 });
      if (add.code !== 0) throw new Error(add.stderr.trim());
      const remove = await this.run("git", ["worktree", "remove", worktree], { cwd: repo, timeout: 10_000 });
      if (remove.code !== 0) throw new Error(remove.stderr.trim());
      return { name: "Git worktrees", ok: true, detail: "create and cleanup succeeded" };
    } catch (error) {
      return { name: "Git worktrees", ok: false, detail: (error as Error).message, remediation: "Upgrade Git and verify temporary directories are writable." };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  private async staleSessions(stateRoot: string): Promise<DoctorCheck> {
    const result = await this.run("tmux", ["list-sessions", "-F", "#{session_name}"], { timeout: 5_000 });
    if (result.code !== 0 && !/no server running|no sessions/i.test(result.stderr)) {
      return { name: "stale tmux sessions", ok: false, detail: result.stderr.trim() };
    }
    const sessions = result.stdout.split("\n").filter((name) => name.startsWith("pi-agents-"));
    const stale: string[] = [];
    for (const session of sessions) {
      const parentSessionId = session.slice("pi-agents-".length);
      try { await access(join(dirname(stateRoot), parentSessionId), constants.F_OK); }
      catch { stale.push(session); }
    }
    return stale.length
      ? { name: "stale tmux sessions", ok: false, detail: stale.join(", "), remediation: "Inspect each session, then remove confirmed stale sessions with `tmux kill-session -t <name>`." }
      : { name: "stale tmux sessions", ok: true, detail: sessions.length ? `${sessions.length} managed session(s), all with durable state` : "none found" };
  }
}

export function formatDoctorReport(checks: readonly DoctorCheck[]): string {
  return checks.map((check) => `${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}${check.ok || !check.remediation ? "" : `\n  ${check.remediation}`}`).join("\n");
}

async function writableDirectory(path: string): Promise<DoctorCheck> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await access(path, constants.R_OK | constants.W_OK);
    const mode = (await stat(path)).mode & 0o777;
    return mode === 0o700
      ? { name: "state directory", ok: true, detail: `${path} (0700)` }
      : { name: "state directory", ok: false, detail: `${path} (${mode.toString(8)})`, remediation: `Run chmod 700 ${path}` };
  } catch (error) {
    return { name: "state directory", ok: false, detail: (error as Error).message, remediation: `Ensure ${path} is private and writable.` };
  }
}

function nodeVersionCheck(): DoctorCheck {
  const detail = process.version;
  return versionAtLeast(detail, 22, 19)
    ? { name: "node", ok: true, detail }
    : { name: "node", ok: false, detail, remediation: "Install Node.js 22.19 or newer." };
}

function versionAtLeast(value: string, major: number, minor: number): boolean {
  const match = value.match(/(\d+)\.(\d+)/);
  if (!match) return false;
  const actualMajor = Number(match[1]);
  const actualMinor = Number(match[2]);
  return actualMajor > major || (actualMajor === major && actualMinor >= minor);
}

function installTmuxCommand(): string {
  if (process.platform === "darwin") return "Install with `brew install tmux`.";
  return "Install tmux 3.2+ with your distribution package manager (for example apt, dnf, or pacman).";
}
