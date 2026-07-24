import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig } from "../src/core/config.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("configuration", () => {
  it("merges trusted project settings over global settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-config-"));
    dirs.push(root);
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await mkdir(agentDir);
    await writeFile(join(agentDir, "tmux-agents.json"), JSON.stringify({ idleTimeoutMs: 1000 }));
    await writeFile(join(cwd, ".pi", "tmux-agents.json"), JSON.stringify({ idleTimeoutMs: 2000 }));
    expect((await loadConfig(cwd, agentDir, true)).idleTimeoutMs).toBe(2000);
    expect((await loadConfig(cwd, agentDir, false)).idleTimeoutMs).toBe(1000);
    expect((await loadConfig(join(root, "other"), join(root, "missing"), false)).monitorIntervalMs).toBe(DEFAULT_CONFIG.monitorIntervalMs);
  });
});
