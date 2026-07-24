import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
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
    const checks = await Promise.all([
      this.command("tmux", ["-V"], "tmux", installTmuxCommand()),
      this.command("git", ["--version"], "git", "Install Git using your system package manager."),
      this.command(process.execPath, ["--version"], "node", "Install Node.js 22.19 or newer."),
      this.tmuxOption("extended-keys", "on", "Add `set -g extended-keys on` to ~/.tmux.conf."),
      this.tmuxOption("extended-keys-format", "csi-u", "For tmux 3.5+, add `set -g extended-keys-format csi-u` to ~/.tmux.conf."),
    ]);
    checks.push(await writableDirectory(stateRoot));
    return checks;
  }

  private async command(command: string, args: string[], name: string, remediation: string): Promise<DoctorCheck> {
    const result = await this.run(command, args, { timeout: 5_000 });
    return result.code === 0
      ? { name, ok: true, detail: (result.stdout || result.stderr).trim() }
      : { name, ok: false, detail: result.stderr.trim() || "not available", remediation };
  }

  private async tmuxOption(option: string, expected: string, remediation: string): Promise<DoctorCheck> {
    const result = await this.run("tmux", ["show-options", "-gqv", option], { timeout: 5_000 });
    const actual = result.stdout.trim();
    return actual === expected
      ? { name: `tmux ${option}`, ok: true, detail: actual }
      : { name: `tmux ${option}`, ok: false, detail: actual || "not configured", remediation };
  }
}

export function formatDoctorReport(checks: readonly DoctorCheck[]): string {
  return checks.map((check) => `${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}${check.ok || !check.remediation ? "" : `\n  ${check.remediation}`}`).join("\n");
}

async function writableDirectory(path: string): Promise<DoctorCheck> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await access(path, constants.R_OK | constants.W_OK);
    return { name: "state directory", ok: true, detail: path };
  } catch (error) {
    return { name: "state directory", ok: false, detail: (error as Error).message, remediation: `Ensure ${path} is private and writable.` };
  }
}

function installTmuxCommand(): string {
  if (process.platform === "darwin") return "Install with `brew install tmux`.";
  return "Install tmux with your distribution package manager (for example `apt install tmux`, `dnf install tmux`, or `pacman -S tmux`).";
}
