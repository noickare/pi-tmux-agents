import { describe, expect, it, vi } from "vitest";
import { TmuxService } from "../src/services/tmux.js";
import type { CommandRunner } from "../src/services/command-runner.js";

describe("TmuxService", () => {
  it("passes commands as argv without shell interpolation", async () => {
    const run = vi.fn<CommandRunner>().mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    const tmux = new TmuxService(run);
    await tmux.createSession("pi-agents-parent", "worker-1", ["node", "runner.js", "--task", "spaces are safe"], "/repo");
    expect(run).toHaveBeenCalledWith("tmux", [
      "new-session", "-d", "-s", "pi-agents-parent", "-n", "worker-1", "-c", "/repo", "--",
      "node", "runner.js", "--task", "spaces are safe",
    ]);
  });

  it("rejects unsafe tmux identifiers", () => {
    const tmux = new TmuxService(vi.fn<CommandRunner>());
    expect(() => tmux.target("bad;session", "worker")).toThrow("Invalid tmux session");
  });
});
