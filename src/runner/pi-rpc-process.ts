import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Writable } from "node:stream";
import { JsonlDecoder } from "./jsonl-decoder.js";
import { isRpcResponse, type RpcCommand, type RpcEvent, type RpcResponse, type RpcTransport } from "./rpc-types.js";

interface PendingRequest {
  resolve(response: RpcResponse): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

export interface PiRpcProcessOptions {
  command?: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  onStderr?: (text: string) => void;
}

export class PiRpcProcess implements RpcTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly listeners = new Set<(event: RpcEvent) => void>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private nextId = 0;
  private closed = false;

  constructor(options: PiRpcProcessOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.child = spawn(options.command ?? "pi", [...options.args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const decoder = new JsonlDecoder((record) => this.handleRecord(record));
    this.child.stdout.on("data", (chunk: Buffer) => decoder.push(chunk));
    this.child.stdout.on("end", () => decoder.end());
    this.child.stderr.on("data", (chunk: Buffer) => options.onStderr?.(chunk.toString()));
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("close", (code, signal) => {
      this.closed = true;
      this.rejectAll(new Error(`pi RPC exited (${signal ?? code ?? "unknown"})`));
      this.emit({ type: "transport_closed", code, signal });
    });
  }

  get pid(): number | undefined { return this.child.pid; }

  send(command: RpcCommand): Promise<RpcResponse> {
    if (this.closed) return Promise.reject(new Error("pi RPC transport is closed"));
    const id = command.id ?? `runner-${++this.nextId}`;
    const request = { ...command, id };
    return new Promise<RpcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC command timed out: ${command.type}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      writeJsonLine(this.child.stdin, request).catch((error) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  subscribe(listener: (event: RpcEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  pause(): void {
    this.signalProcessTree("SIGSTOP");
  }

  resume(): void {
    this.signalProcessTree("SIGCONT");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try { await this.send({ type: "abort" }); } catch { /* process may already be gone */ }
    this.signalProcessTree("SIGTERM");
  }

  private signalProcessTree(signal: NodeJS.Signals): void {
    if (!this.child.pid) return;
    const target = process.platform === "win32" ? this.child.pid : -this.child.pid;
    try { process.kill(target, signal); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  private handleRecord(record: unknown): void {
    if (isRpcResponse(record) && record.id) {
      const pending = this.pending.get(record.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(record.id);
        pending.resolve(record);
        return;
      }
    }
    if (record && typeof record === "object" && typeof (record as RpcEvent).type === "string") {
      this.emit(record as RpcEvent);
    }
  }

  private emit(event: RpcEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private rejectAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.pending.clear();
  }
}

async function writeJsonLine(stream: Writable, value: unknown): Promise<void> {
  const line = `${JSON.stringify(value)}\n`;
  await new Promise<void>((resolve, reject) => {
    stream.write(line, (error) => error ? reject(error) : resolve());
  });
}
