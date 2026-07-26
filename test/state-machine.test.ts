import { describe, expect, it } from "vitest";
import { assertTransition, canTransition, isTerminalStatus } from "../src/core/state-machine.js";

describe("agent state machine", () => {
  it("requires parent review after a child settles", () => {
    expect(canTransition("running", "awaiting_review")).toBe(true);
    expect(canTransition("awaiting_review", "running")).toBe(true);
    expect(canTransition("awaiting_review", "closed")).toBe(true);
    expect(canTransition("awaiting_review", "idle")).toBe(false);
  });

  it("rejects impossible transitions", () => {
    expect(() => assertTransition("closed", "running")).toThrow("closed -> running");
  });

  it("classifies terminal statuses", () => {
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("idle")).toBe(false);
  });
});
