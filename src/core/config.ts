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
  minimumFreeMemoryBytes: number;
  criticalFreeMemoryBytes: number;
  minimumFreeDiskBytes: number;
  maximumLoadPerAvailableCpu: number;
  autoPauseOnCritical: boolean;
  autoRemediateStuck: boolean;
  remediationGraceMs: number;
  resourceRecoveryStableMs: number;
  queueStaleMs: number;
  uiRequestStaleMs: number;
  animationEnabled: boolean;
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
  minimumFreeMemoryBytes: 2 * 1024 ** 3,
  criticalFreeMemoryBytes: 512 * 1024 ** 2,
  minimumFreeDiskBytes: 5 * 1024 ** 3,
  maximumLoadPerAvailableCpu: 1.25,
  autoPauseOnCritical: true,
  autoRemediateStuck: true,
  remediationGraceMs: 2 * 60_000,
  resourceRecoveryStableMs: 30_000,
  queueStaleMs: 30 * 60_000,
  uiRequestStaleMs: 60_000,
  animationEnabled: true,
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
    "minimumFreeMemoryBytes", "criticalFreeMemoryBytes", "minimumFreeDiskBytes", "maximumLoadPerAvailableCpu",
    "remediationGraceMs", "resourceRecoveryStableMs", "queueStaleMs", "uiRequestStaleMs",
  ];
  for (const key of positive) {
    const candidate = value[key];
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate <= 0) throw new Error(`Invalid tmux-agents config: ${key}`);
  }
  if (!Number.isInteger(value.parentReservedCpu) || value.parentReservedCpu < 0) throw new Error("Invalid tmux-agents config: parentReservedCpu");
  for (const key of ["autoPauseOnCritical", "autoRemediateStuck", "animationEnabled"] as const) {
    if (typeof value[key] !== "boolean") throw new Error(`Invalid tmux-agents config: ${key}`);
  }
  if (value.criticalFreeMemoryBytes > value.minimumFreeMemoryBytes) throw new Error("criticalFreeMemoryBytes must not exceed minimumFreeMemoryBytes");
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
