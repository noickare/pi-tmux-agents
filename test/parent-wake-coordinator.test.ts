import { describe, expect, it } from "vitest";
import { ParentWakeCoordinator } from "../src/services/parent-wake-coordinator.js";

describe("ParentWakeCoordinator", () => {
  it("coalesces pending updates by key and evaluates current state when drained", () => {
    const coordinator = new ParentWakeCoordinator();
    let status = "running";
    coordinator.enqueue("watchdog", () => ({ content: "stale running finding", fingerprint: "running" }));
    status = "replaced";
    coordinator.enqueue("watchdog", () => status === "running"
      ? { content: "stale running finding", fingerprint: "running" }
      : undefined);

    expect(coordinator.drain()).toEqual([]);
  });

  it("suppresses unchanged reports until the key is cleared", () => {
    const coordinator = new ParentWakeCoordinator();
    const report = () => ({ content: "same finding", fingerprint: "same" });
    coordinator.enqueue("watchdog", report);
    expect(coordinator.drain()).toEqual(["same finding"]);
    coordinator.enqueue("watchdog", report);
    expect(coordinator.drain()).toEqual([]);
    coordinator.clear("watchdog");
    coordinator.enqueue("watchdog", report);
    expect(coordinator.drain()).toEqual(["same finding"]);
  });

  it("combines independent pending supervision messages", () => {
    const coordinator = new ParentWakeCoordinator();
    coordinator.enqueue("completion:one", () => ({ content: "one completed", fingerprint: "1" }));
    coordinator.enqueue("attention:two", () => ({ content: "two failed", fingerprint: "failed" }));
    expect(coordinator.drain()).toEqual(["one completed", "two failed"]);
  });
});
