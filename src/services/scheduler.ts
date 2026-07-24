import type { AgentPriority, AgentWeight } from "../core/protocol.js";

export type TaskWeight = AgentWeight;

export const PRIORITY_RANK: Readonly<Record<AgentPriority, number>> = {
  interactive: 0,
  "merge-critical": 1,
  normal: 2,
  speculative: 3,
};

export interface ResourceSnapshot {
  cpuCount: number;
  loadAverage1m: number;
  totalMemoryBytes: number;
  availableMemoryBytes: number;
  availableDiskBytes: number;
  activeWeight: number;
  parentReservedCpu: number;
  parentReservedMemoryBytes: number;
  providerBackoff: boolean;
}

export interface AdmissionDecision {
  admitted: boolean;
  reason: string;
  pressure: "normal" | "elevated" | "critical";
  score: number;
}

const WEIGHTS: Readonly<Record<TaskWeight, number>> = { light: 0.5, normal: 1, heavy: 2 };

export interface SchedulerThresholds {
  minimumFreeMemoryBytes: number;
  criticalFreeMemoryBytes: number;
  minimumFreeDiskBytes: number;
  maximumLoadPerAvailableCpu: number;
}

export const DEFAULT_THRESHOLDS: SchedulerThresholds = {
  minimumFreeMemoryBytes: 2 * 1024 ** 3,
  criticalFreeMemoryBytes: 512 * 1024 ** 2,
  minimumFreeDiskBytes: 5 * 1024 ** 3,
  maximumLoadPerAvailableCpu: 1.25,
};

export function assessResourcePressure(
  resources: ResourceSnapshot,
  thresholds: SchedulerThresholds = DEFAULT_THRESHOLDS,
): AdmissionDecision["pressure"] {
  const usableCpu = Math.max(1, resources.cpuCount - resources.parentReservedCpu);
  const usableMemory = resources.availableMemoryBytes - resources.parentReservedMemoryBytes;
  const loadPressure = Math.max(resources.loadAverage1m / usableCpu, resources.activeWeight / usableCpu);
  if (usableMemory <= thresholds.criticalFreeMemoryBytes || resources.availableDiskBytes <= thresholds.minimumFreeDiskBytes ||
    loadPressure > thresholds.maximumLoadPerAvailableCpu * 2) return "critical";
  if (resources.providerBackoff || usableMemory <= thresholds.minimumFreeMemoryBytes || loadPressure > thresholds.maximumLoadPerAvailableCpu) return "elevated";
  return "normal";
}

export function decideAdmission(
  resources: ResourceSnapshot,
  taskWeight: TaskWeight,
  thresholds: SchedulerThresholds = DEFAULT_THRESHOLDS,
): AdmissionDecision {
  const usableCpu = Math.max(1, resources.cpuCount - resources.parentReservedCpu);
  const usableMemory = resources.availableMemoryBytes - resources.parentReservedMemoryBytes;
  const loadRatio = resources.loadAverage1m / usableCpu;
  const requestedWeight = WEIGHTS[taskWeight];
  const projectedWeight = resources.activeWeight + requestedWeight;
  const score = Math.max(loadRatio, projectedWeight / usableCpu);

  if (usableMemory <= thresholds.criticalFreeMemoryBytes) {
    return { admitted: false, reason: "critical memory pressure", pressure: "critical", score };
  }
  if (resources.availableDiskBytes <= thresholds.minimumFreeDiskBytes) {
    return { admitted: false, reason: "insufficient disk reservation", pressure: "critical", score };
  }
  if (score > thresholds.maximumLoadPerAvailableCpu * 2) {
    return { admitted: false, reason: "critical CPU or active-work pressure", pressure: "critical", score };
  }
  if (resources.providerBackoff) {
    return { admitted: false, reason: "provider is backing off", pressure: "elevated", score };
  }
  if (usableMemory <= thresholds.minimumFreeMemoryBytes) {
    return { admitted: false, reason: "memory reservation would be exceeded", pressure: "elevated", score };
  }
  if (score > thresholds.maximumLoadPerAvailableCpu) {
    return { admitted: false, reason: "CPU admission threshold reached", pressure: "elevated", score };
  }
  return { admitted: true, reason: "resources available", pressure: "normal", score };
}
