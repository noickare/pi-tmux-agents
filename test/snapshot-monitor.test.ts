import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRegistry } from "../src/core/registry.js";
import { AgentStateStore } from "../src/core/state-store.js";
import { SnapshotMonitor } from "../src/services/snapshot-monitor.js";
import { snapshot } from "./fixtures.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("SnapshotMonitor", () => {
  it("discovers and removes durable agent snapshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-monitor-"));
    dirs.push(root);
    const child = join(root, "worker-1");
    await mkdir(child);
    await new AgentStateStore(child).writeSnapshot(snapshot());
    const registry = new AgentRegistry();
    const monitor = new SnapshotMonitor(root, registry);
    expect(await monitor.scan()).toBe(1);
    expect(registry.get("worker-1")?.status).toBe("running");
    await rm(child, { recursive: true });
    expect(await monitor.scan()).toBe(0);
    expect(registry.list()).toHaveLength(0);
  });
});
