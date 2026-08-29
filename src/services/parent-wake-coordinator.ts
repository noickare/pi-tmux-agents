export interface ParentWakeMessage {
  content: string;
  fingerprint: string;
}

export type ParentWakeProducer = () => ParentWakeMessage | undefined;

/** Coalesces supervision wakeups while the parent is busy and suppresses unchanged repeats. */
export class ParentWakeCoordinator {
  private readonly pending = new Map<string, ParentWakeProducer>();
  private readonly delivered = new Map<string, string>();
  private uiPromptActive = false;

  enqueue(key: string, producer: ParentWakeProducer): void {
    this.pending.set(key, producer);
  }

  clear(key: string): void {
    this.pending.delete(key);
    this.delivered.delete(key);
  }

  reset(): void {
    this.pending.clear();
    this.delivered.clear();
    this.uiPromptActive = false;
  }

  setUiPromptActive(active: boolean): void {
    this.uiPromptActive = active;
  }

  hasPending(): boolean {
    return this.pending.size > 0;
  }

  drain(): string[] {
    if (this.uiPromptActive) return [];
    const pending = [...this.pending.entries()];
    this.pending.clear();
    const messages: string[] = [];
    for (const [key, producer] of pending) {
      const message = producer();
      if (!message || this.delivered.get(key) === message.fingerprint) continue;
      this.delivered.set(key, message.fingerprint);
      messages.push(message.content);
    }
    return messages;
  }
}
