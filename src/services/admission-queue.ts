import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SpawnAgentInput } from "./orchestrator.js";

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
      return Array.isArray(value) ? value as QueuedSpawn[] : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async add(item: QueuedSpawn): Promise<void> {
    const items = await this.list();
    if (!items.some((candidate) => candidate.id === item.id)) items.push(item);
    await this.write(items);
  }

  async remove(id: string): Promise<void> {
    await this.write((await this.list()).filter((item) => item.id !== id));
  }

  private async write(items: readonly QueuedSpawn[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(items, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.path);
  }
}
