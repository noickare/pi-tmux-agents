import { appendFile, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentCommand, AgentEvent, AgentSnapshot } from "./protocol.js";
import { isAgentCommand } from "./protocol.js";

export interface JsonlReadResult<T> {
  records: T[];
  ignoredTrailingFragment: boolean;
}

export class AgentStateStore {
  constructor(readonly directory: string) {}

  get commandsPath(): string { return join(this.directory, "commands.jsonl"); }
  get eventsPath(): string { return join(this.directory, "events.jsonl"); }
  get snapshotPath(): string { return join(this.directory, "snapshot.json"); }

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
  }

  async appendCommand(command: AgentCommand): Promise<void> {
    if (!isAgentCommand(command)) throw new Error("Refusing to persist an invalid agent command");
    await this.appendJsonLine(this.commandsPath, command);
  }

  async appendEvent(event: AgentEvent): Promise<void> {
    await this.appendJsonLine(this.eventsPath, event);
  }

  async writeSnapshot(snapshot: AgentSnapshot): Promise<void> {
    await this.initialize();
    const temporary = `${this.snapshotPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.snapshotPath);
  }

  async readSnapshot(): Promise<AgentSnapshot | undefined> {
    try {
      return JSON.parse(await readFile(this.snapshotPath, "utf8")) as AgentSnapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async readCommands(): Promise<JsonlReadResult<AgentCommand>> {
    return readJsonl(this.commandsPath, isAgentCommand);
  }

  async readEvents(): Promise<JsonlReadResult<AgentEvent>> {
    return readJsonl(this.eventsPath, isAgentEvent);
  }

  private async appendJsonLine(path: string, value: unknown): Promise<void> {
    await this.initialize();
    await appendFile(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(path, 0o600);
  }
}

export async function readJsonl<T>(path: string, validate: (value: unknown) => value is T): Promise<JsonlReadResult<T>> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], ignoredTrailingFragment: false };
    throw error;
  }

  const complete = content.endsWith("\n");
  const lines = content.split("\n");
  if (complete) lines.pop();
  const records: T[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (!validate(value)) throw new Error("record failed validation");
      records.push(value);
    } catch (error) {
      const isTrailingFragment = !complete && index === lines.length - 1;
      if (isTrailingFragment) return { records, ignoredTrailingFragment: true };
      throw new Error(`Invalid JSONL record ${index + 1} in ${path}: ${(error as Error).message}`);
    }
  }

  return { records, ignoredTrailingFragment: false };
}

function isAgentEvent(value: unknown): value is AgentEvent {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<AgentEvent>;
  return item.protocolVersion === 1 && typeof item.id === "string" && typeof item.agentId === "string" &&
    typeof item.sequence === "number" && typeof item.type === "string" && typeof item.createdAt === "string";
}
