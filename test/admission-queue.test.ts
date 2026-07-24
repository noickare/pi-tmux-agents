import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdmissionQueue, type QueuedSpawn } from "../src/services/admission-queue.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("AdmissionQueue", () => {
  it("serializes parallel mutations and uses collision-proof atomic writes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-admission-queue-"));
    dirs.push(directory);
    const path = join(directory, "queue.json");
    const queues = [new AdmissionQueue(path), new AdmissionQueue(path)];
    const items = Array.from({ length: 16 }, (_, index): QueuedSpawn => ({
      id: `request-${index}`,
      agentId: `worker-${index}`,
      createdAt: new Date(1_700_000_000_000 + index).toISOString(),
      reason: "resource pressure",
      input: {
        name: "worker",
        task: `task-${index}`,
        cwd: directory,
        mutating: false,
        priority: "normal",
        weight: "light",
      },
    }));

    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    await Promise.all(items.map((item, index) => queues[index % queues.length]!.add(item)));
    await Promise.all([
      queues[0]!.reprioritize("worker-3", "interactive"),
      queues[1]!.remove("request-7"),
    ]);

    const persisted = JSON.parse(await readFile(path, "utf8")) as QueuedSpawn[];
    expect(persisted).toHaveLength(15);
    expect(new Set(persisted.map((item) => item.id)).size).toBe(15);
    expect(persisted.find((item) => item.agentId === "worker-3")?.input.priority).toBe("interactive");
    expect(persisted.some((item) => item.id === "request-7")).toBe(false);
  });
});
