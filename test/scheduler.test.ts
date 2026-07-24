import { describe, expect, it } from "vitest";
import { decideAdmission, type ResourceSnapshot } from "../src/services/scheduler.js";

const healthy: ResourceSnapshot = {
  cpuCount: 12,
  loadAverage1m: 2,
  totalMemoryBytes: 32 * 1024 ** 3,
  availableMemoryBytes: 20 * 1024 ** 3,
  availableDiskBytes: 100 * 1024 ** 3,
  activeWeight: 3,
  parentReservedCpu: 2,
  parentReservedMemoryBytes: 2 * 1024 ** 3,
  providerBackoff: false,
};

describe("resource-aware scheduler", () => {
  it("admits work without using a fixed agent count", () => {
    expect(decideAdmission(healthy, "heavy").admitted).toBe(true);
  });

  it("queues work during provider backoff", () => {
    expect(decideAdmission({ ...healthy, providerBackoff: true }, "light")).toMatchObject({ admitted: false, pressure: "elevated" });
  });

  it("protects the parent memory reservation", () => {
    const decision = decideAdmission({ ...healthy, availableMemoryBytes: 2.4 * 1024 ** 3 }, "normal");
    expect(decision).toMatchObject({ admitted: false, pressure: "critical" });
  });
});
