import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { AgentRegistry } from "../core/registry.js";
import { AgentStateStore } from "../core/state-store.js";

export interface SnapshotMonitorOptions {
  intervalMs?: number;
  onError?: (error: Error) => void;
  onScan?: (date: Date) => void;
}

export class SnapshotMonitor {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    readonly stateRoot: string,
    private readonly registry: AgentRegistry,
    private readonly options: SnapshotMonitorOptions = {},
  ) {}

  async start(): Promise<void> {
    await this.scan();
    this.timer = setInterval(() => void this.scan().catch((error: unknown) => this.options.onError?.(error as Error)), this.options.intervalMs ?? 1_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async scan(): Promise<number> {
    let entries;
    try {
      entries = await readdir(this.stateRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        for (const snapshot of this.registry.list()) this.registry.remove(snapshot.agentId);
        this.options.onScan?.(new Date());
        return 0;
      }
      throw error;
    }

    const seen = new Set<string>();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const snapshot = await new AgentStateStore(join(this.stateRoot, entry.name)).readSnapshot();
      if (!snapshot) continue;
      seen.add(snapshot.agentId);
      this.registry.upsert(snapshot);
    }
    for (const snapshot of this.registry.list()) if (!seen.has(snapshot.agentId)) this.registry.remove(snapshot.agentId);
    this.options.onScan?.(new Date());
    return seen.size;
  }
}
