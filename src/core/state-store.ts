import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentCommand, AgentEvent, AgentSnapshot, AgentTaskResult } from "./protocol.js";
import { isAgentCommand, PROTOCOL_VERSION } from "./protocol.js";

export interface JsonlReadResult<T> {
  records: T[];
  ignoredTrailingFragment: boolean;
}

export class AgentStateStore {
  private snapshotWrites = Promise.resolve();

  constructor(readonly directory: string) {}

  get commandsPath(): string { return join(this.directory, "commands.jsonl"); }
  get eventsPath(): string { return join(this.directory, "events.jsonl"); }
  get snapshotPath(): string { return join(this.directory, "snapshot.json"); }
  resultPath(assignmentId: string, attemptId: string): string {
    return join(this.directory, "assignments", safeSegment(assignmentId), "attempts", safeSegment(attemptId), "result.json");
  }

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
    const candidate = structuredClone(snapshot);
    const write = this.snapshotWrites.then(async () => {
      const current = await this.readSnapshot();
      if (current && current.lastSequence > candidate.lastSequence) return;
      await this.initialize();
      const temporary = `${this.snapshotPath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(candidate, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, this.snapshotPath);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    this.snapshotWrites = write.catch(() => undefined);
    return write;
  }

  async readSnapshot(): Promise<AgentSnapshot | undefined> {
    try {
      const value = JSON.parse(await readFile(this.snapshotPath, "utf8")) as Partial<AgentSnapshot>;
      return value.protocolVersion === PROTOCOL_VERSION ? value as AgentSnapshot : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async writeResult(result: AgentTaskResult): Promise<string> {
    const path = this.resultPath(result.assignmentId, result.attemptId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    return path;
  }

  async readResult(assignmentId: string, attemptId: string): Promise<AgentTaskResult | undefined> {
    try {
      const value = JSON.parse(await readFile(this.resultPath(assignmentId, attemptId), "utf8")) as Partial<AgentTaskResult>;
      return value.protocolVersion === PROTOCOL_VERSION ? value as AgentTaskResult : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async readLatestResult(): Promise<AgentTaskResult | undefined> {
    const root = join(this.directory, "assignments");
    let assignments;
    try { assignments = await readdir(root, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    const results: AgentTaskResult[] = [];
    for (const assignment of assignments) {
      if (!assignment.isDirectory()) continue;
      const attemptsRoot = join(root, assignment.name, "attempts");
      let attempts;
      try { attempts = await readdir(attemptsRoot, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      for (const attempt of attempts) {
        if (!attempt.isDirectory()) continue;
        try {
          const value = JSON.parse(await readFile(join(attemptsRoot, attempt.name, "result.json"), "utf8")) as Partial<AgentTaskResult>;
          if (value.protocolVersion === PROTOCOL_VERSION) results.push(value as AgentTaskResult);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    return results.sort((left, right) => right.completedAt.localeCompare(left.completedAt))[0];
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

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") throw new Error("Result identifiers must be safe path segments");
  return value;
}

function isAgentEvent(value: unknown): value is AgentEvent {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<AgentEvent>;
  return item.protocolVersion === PROTOCOL_VERSION && typeof item.id === "string" && typeof item.agentId === "string" &&
    typeof item.sequence === "number" && typeof item.type === "string" && typeof item.createdAt === "string";
}
