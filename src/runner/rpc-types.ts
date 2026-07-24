export interface RpcCommand {
  id?: string;
  type: string;
  [key: string]: unknown;
}

export interface RpcResponse {
  type: "response";
  command: string;
  success: boolean;
  id?: string;
  data?: unknown;
  error?: string;
}

export interface RpcEvent {
  type: string;
  [key: string]: unknown;
}

export interface RpcTransport {
  readonly pid: number | undefined;
  send(command: RpcCommand): Promise<RpcResponse>;
  subscribe(listener: (event: RpcEvent) => void): () => void;
  pause(): void;
  resume(): void;
  close(): Promise<void>;
}

export function isRpcResponse(value: unknown): value is RpcResponse {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<RpcResponse>;
  return item.type === "response" && typeof item.command === "string" && typeof item.success === "boolean";
}
