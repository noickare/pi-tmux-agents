import { describe, expect, it } from "vitest";
import { assertTransition, canTransition, isTerminalStatus } from "../src/core/state-machine.js";

describe("agent state machine", () => {
  it("supports persistent completion returning to idle", () => {
    expect(canTransition("running", "completed")).toBe(true);
    expect(canTransition("completed", "idle")).toBe(true);
  });

  it("rejects impossible transitions", () => {
    expect(() => assertTransition("closed", "running")).toThrow("closed -> running");
  });

  it("classifies terminal statuses", () => {
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("idle")).toBe(false);
  });
});
