import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRegistry } from "../src/core/registry.js";
import { AgentStateStore } from "../src/core/state-store.js";
import type { CommandRunner } from "../src/services/command-runner.js";
import { SnapshotMonitor } from "../src/services/snapshot-monitor.js";
import { TmuxService } from "../src/services/tmux.js";
import { AgentWatchdog } from "../src/services/watchdog.js";
import { snapshot } from "./fixtures.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("AgentWatchdog", () => {
  it("reports stale heartbeat, progress, and missing tmux", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-watchdog-"));
    dirs.push(root);
    const child = join(root, "worker-1");
    await mkdir(child);
    await new AgentStateStore(child).writeSnapshot(snapshot({
      tmuxTarget: "pi-agents-parent:worker-1",
      lastHeartbeatAt: "2026-07-23T09:58:00.000Z",
      lastProgressAt: "2026-07-23T09:40:00.000Z",
    }));
    const run = vi.fn<CommandRunner>().mockResolvedValue({ stdout: "", stderr: "missing", code: 1 });
    const monitor = new SnapshotMonitor(root, new AgentRegistry());
    const findings = await new AgentWatchdog(monitor, new TmuxService(run), {
      now: () => new Date("2026-07-23T10:00:00.000Z"),
    }).check();
    expect(findings.map((item) => item.kind)).toEqual(expect.arrayContaining(["heartbeat_stale", "progress_stale", "tmux_missing"]));
  });
});
