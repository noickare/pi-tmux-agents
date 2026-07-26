import type { Theme } from "@earendil-works/pi-coding-agent";
import { PROTOCOL_VERSION, type AgentSnapshot, type AgentStatus } from "../src/core/protocol.js";

export const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;

type SnapshotOverrides = Omit<Partial<AgentSnapshot>, "currentTool"> & { currentTool?: string | undefined };

export function snapshot(overrides: SnapshotOverrides = {}): AgentSnapshot {
  const result = {
    protocolVersion: PROTOCOL_VERSION,
    agentId: "worker-1",
    name: "worker-1",
    status: "running" as AgentStatus,
    cwd: "/repo",
    task: "Implement the persistent runner",
    currentTool: "$ npm test",
    startedAt: "2026-07-23T10:00:00.000Z",
    updatedAt: "2026-07-23T10:01:00.000Z",
    lastHeartbeatAt: "2026-07-23T10:01:00.000Z",
    lastProgressAt: "2026-07-23T10:01:00.000Z",
    nextParentReviewAt: "2026-07-23T10:05:00.000Z",
    queuedMessages: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 },
    lastSequence: 0,
    ...overrides,
  } as AgentSnapshot;
  if ("currentTool" in overrides && overrides.currentTool === undefined) delete result.currentTool;
  return result;
}
