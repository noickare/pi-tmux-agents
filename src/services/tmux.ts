import { assertSafeId } from "../core/paths.js";
import type { CommandRunner } from "./command-runner.js";
import { requireSuccess } from "./command-runner.js";

export interface TmuxWindow {
  session: string;
  index: number;
  name: string;
  active: boolean;
  dead: boolean;
  pid: number;
}

export class TmuxService {
  constructor(private readonly run: CommandRunner) {}

  async version(): Promise<string> {
    const result = requireSuccess(await this.run("tmux", ["-V"]), "tmux version check");
    return result.stdout.trim();
  }

  async hasSession(session: string): Promise<boolean> {
    assertSafeId(session, "tmux session");
    const result = await this.run("tmux", ["has-session", "-t", session]);
    return result.code === 0;
  }

  async createSession(session: string, window: string, command: readonly string[], cwd: string): Promise<void> {
    assertSafeId(session, "tmux session");
    assertSafeId(window, "tmux window");
    if (command.length === 0) throw new Error("tmux window command cannot be empty");
    requireSuccess(await this.run("tmux", [
      "new-session", "-d", "-s", session, "-n", window, "-c", cwd, "--", ...command,
    ]), `create tmux session ${session}`);
  }

  async createWindow(session: string, window: string, command: readonly string[], cwd: string): Promise<void> {
    assertSafeId(session, "tmux session");
    assertSafeId(window, "tmux window");
    if (command.length === 0) throw new Error("tmux window command cannot be empty");
    requireSuccess(await this.run("tmux", [
      "new-window", "-d", "-t", session, "-n", window, "-c", cwd, "--", ...command,
    ]), `create tmux window ${session}:${window}`);
  }

  async listWindows(session: string): Promise<TmuxWindow[]> {
    assertSafeId(session, "tmux session");
    const format = "#{session_name}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_dead}\t#{pane_pid}";
    const result = requireSuccess(await this.run("tmux", ["list-windows", "-t", session, "-F", format]), "list tmux windows");
    return result.stdout.trim().split("\n").filter(Boolean).map((line) => {
      const [sessionName, index, name, active, dead, pid] = line.split("\t");
      if (!sessionName || !index || !name || !pid) throw new Error(`Unexpected tmux output: ${line}`);
      return { session: sessionName, index: Number(index), name, active: active === "1", dead: dead === "1", pid: Number(pid) };
    });
  }

  async killWindow(session: string, window: string): Promise<void> {
    assertSafeId(session, "tmux session");
    assertSafeId(window, "tmux window");
    requireSuccess(await this.run("tmux", ["kill-window", "-t", `${session}:${window}`]), "kill tmux window");
  }

  target(session: string, window: string): string {
    return `${assertSafeId(session, "tmux session")}:${assertSafeId(window, "tmux window")}`;
  }
}
