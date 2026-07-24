import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export interface TmuxAgentsConfig {
  monitorIntervalMs: number;
  watchdogIntervalMs: number;
  heartbeatStaleMs: number;
  progressStaleMs: number;
  parentReviewIntervalMs: number;
  schedulerIntervalMs: number;
  idleTimeoutMs: number;
  parentReservedCpu: number;
  parentReservedMemoryBytes: number;
}

export const DEFAULT_CONFIG: TmuxAgentsConfig = {
  monitorIntervalMs: 1_000,
  watchdogIntervalMs: 30_000,
  heartbeatStaleMs: 30_000,
  progressStaleMs: 10 * 60_000,
  parentReviewIntervalMs: 5 * 60_000,
  schedulerIntervalMs: 5_000,
  idleTimeoutMs: 4 * 60 * 60_000,
  parentReservedCpu: 1,
  parentReservedMemoryBytes: 1024 ** 3,
};

export async function loadConfig(cwd: string, agentDir: string, projectTrusted: boolean): Promise<TmuxAgentsConfig> {
  const global = await readPartial(join(agentDir, "tmux-agents.json"));
  const project = projectTrusted ? await readPartial(join(cwd, CONFIG_DIR_NAME, "tmux-agents.json")) : {};
  return validateConfig({ ...DEFAULT_CONFIG, ...global, ...project });
}

export function validateConfig(value: TmuxAgentsConfig): TmuxAgentsConfig {
  const positive: Array<keyof TmuxAgentsConfig> = [
    "monitorIntervalMs", "watchdogIntervalMs", "heartbeatStaleMs", "progressStaleMs",
    "parentReviewIntervalMs", "schedulerIntervalMs", "idleTimeoutMs", "parentReservedMemoryBytes",
  ];
  for (const key of positive) if (!Number.isFinite(value[key]) || value[key] <= 0) throw new Error(`Invalid tmux-agents config: ${key}`);
  if (!Number.isInteger(value.parentReservedCpu) || value.parentReservedCpu < 0) throw new Error("Invalid tmux-agents config: parentReservedCpu");
  return value;
}

async function readPartial(path: string): Promise<Partial<TmuxAgentsConfig>> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Config must be an object: ${path}`);
    return value as Partial<TmuxAgentsConfig>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}
