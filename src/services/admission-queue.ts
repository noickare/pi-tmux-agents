import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SpawnAgentInput } from "./orchestrator.js";
import { PRIORITY_RANK } from "./scheduler.js";

export interface QueuedSpawn {
  id: string;
  agentId: string;
  createdAt: string;
  reason: string;
  input: SpawnAgentInput;
}

export class AdmissionQueue {
  constructor(readonly path: string) {}

  async list(): Promise<QueuedSpawn[]> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, "utf8"));
      return Array.isArray(value) ? sortQueue(value as QueuedSpawn[]) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async add(item: QueuedSpawn): Promise<void> {
    await serializeMutation(this.path, async () => {
      const items = await this.list();
      if (!items.some((candidate) => candidate.id === item.id)) items.push(item);
      await this.write(items);
    });
  }

  async remove(id: string): Promise<void> {
    await serializeMutation(this.path, async () => {
      await this.write((await this.list()).filter((item) => item.id !== id));
    });
  }

  async reprioritize(agentId: string, priority: NonNullable<SpawnAgentInput["priority"]>): Promise<boolean> {
    return serializeMutation(this.path, async () => {
      const items = await this.list();
      const item = items.find((candidate) => candidate.agentId === agentId);
      if (!item) return false;
      item.input = { ...item.input, priority };
      await this.write(sortQueue(items));
      return true;
    });
  }

  async health(now = Date.now()): Promise<{ count: number; oldestAgeMs: number; duplicateAgentIds: readonly string[] }> {
    const items = await this.list();
    const ids = new Set<string>();
    const duplicates = new Set<string>();
    for (const item of items) { if (ids.has(item.agentId)) duplicates.add(item.agentId); ids.add(item.agentId); }
    return {
      count: items.length,
      oldestAgeMs: items.reduce((oldest, item) => Math.max(oldest, now - new Date(item.createdAt).getTime()), 0),
      duplicateAgentIds: [...duplicates],
    };
  }

  private async write(items: readonly QueuedSpawn[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(items, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

const mutationQueues = new Map<string, Promise<void>>();

async function serializeMutation<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(path) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => { release = resolve; });
  mutationQueues.set(path, current);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (mutationQueues.get(path) === current) mutationQueues.delete(path);
  }
}

function sortQueue(items: QueuedSpawn[]): QueuedSpawn[] {
  return [...items].sort((left, right) => {
    const priority = PRIORITY_RANK[left.input.priority ?? "normal"] - PRIORITY_RANK[right.input.priority ?? "normal"];
    return priority || left.createdAt.localeCompare(right.createdAt);
  });
}
