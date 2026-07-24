import type { AgentSnapshot } from "./protocol.js";

export type RegistryListener = () => void;

export class AgentRegistry {
  private readonly snapshots = new Map<string, AgentSnapshot>();
  private readonly listeners = new Set<RegistryListener>();

  list(): readonly AgentSnapshot[] {
    return [...this.snapshots.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(agentId: string): AgentSnapshot | undefined {
    return this.snapshots.get(agentId);
  }

  upsert(snapshot: AgentSnapshot): void {
    this.snapshots.set(snapshot.agentId, snapshot);
    this.emit();
  }

  remove(agentId: string): void {
    if (this.snapshots.delete(agentId)) this.emit();
  }

  subscribe(listener: RegistryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
