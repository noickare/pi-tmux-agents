import type { RpcEvent } from "./rpc-types.js";

export interface TranscriptWriter {
  write(text: string): void;
}

export function renderRpcEvent(event: RpcEvent, output: TranscriptWriter): void {
  if (event.type === "message_update") {
    const update = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
    if (update?.type === "text_delta" && update.delta) output.write(update.delta);
    return;
  }
  if (event.type === "tool_execution_start") {
    output.write(`\n→ ${String(event.toolName ?? "tool")} ${compactJson(event.args)}\n`);
    return;
  }
  if (event.type === "tool_execution_end") {
    output.write(`${event.isError === true ? "✗" : "✓"} ${String(event.toolName ?? "tool")}\n`);
    return;
  }
  if (event.type === "auto_retry_start") {
    output.write(`\n↻ retry ${String(event.attempt ?? "")} in ${String(event.delayMs ?? "?")}ms\n`);
    return;
  }
  if (event.type === "compaction_start") output.write("\n◇ compacting context\n");
  if (event.type === "agent_settled") output.write("\n◆ result ready — awaiting parent review\n");
  if (event.type === "transport_closed") output.write("\n✗ RPC transport closed\n");
}

function compactJson(value: unknown): string {
  if (value === undefined) return "";
  const serialized = JSON.stringify(value);
  return serialized.length > 160 ? `${serialized.slice(0, 157)}...` : serialized;
}
