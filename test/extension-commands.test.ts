import { describe, expect, it } from "vitest";
import { formatAgents, formatParentReview, HEALTHY_WATCHDOG_GUIDANCE, needsPeriodicReview, parseNewAgentTask, resolveChildDispatch, resolveChildModel } from "../src/extension/index.js";
import { snapshot } from "./fixtures.js";

describe("/agents command parsing", () => {
  it("preserves the first word of an inline new-agent task", () => {
    expect(parseNewAgentTask("Create", ["agent-output.txt", "now"])).toBe("Create agent-output.txt now");
    expect(parseNewAgentTask(undefined, [])).toBe("");
  });

  it("qualifies bare child models with the active parent provider", () => {
    expect(resolveChildModel("gpt-5.4", { provider: "openai-codex", id: "gpt-5.4" })).toBe("openai-codex/gpt-5.4");
    expect(resolveChildModel("anthropic/claude-sonnet-4-6", { provider: "openai-codex", id: "gpt-5.4" })).toBe("anthropic/claude-sonnet-4-6");
    expect(resolveChildModel(undefined, undefined)).toBeUndefined();
    expect(() => resolveChildModel("gpt-5.4", undefined)).toThrow("provider/model");
  });

  it("inherits parent dispatch settings only when the child has no model override", () => {
    const active = { provider: "openai-codex", id: "gpt-5.4" };
    expect(resolveChildDispatch(undefined, active, "high")).toEqual({ model: "openai-codex/gpt-5.4", thinkingLevel: "high" });
    expect(resolveChildDispatch("gpt-5.3-codex", active, "high")).toEqual({ model: "openai-codex/gpt-5.3-codex" });
    expect(resolveChildDispatch("anthropic/claude-sonnet-4-6", active, "high")).toEqual({ model: "anthropic/claude-sonnet-4-6" });
  });

  it("periodically reviews execution without repeatedly waking for parked or attention states", () => {
    expect(needsPeriodicReview("running")).toBe(true);
    expect(needsPeriodicReview("idle")).toBe(true);
    expect(needsPeriodicReview("queued")).toBe(true);
    expect(needsPeriodicReview("awaiting_review")).toBe(false);
    expect(needsPeriodicReview("blocked")).toBe(false);
    expect(needsPeriodicReview("failed")).toBe(false);
    expect(needsPeriodicReview("orphaned")).toBe(false);
  });

  it("prevents healthy children from being treated as stalled", () => {
    expect(HEALTHY_WATCHDOG_GUIDANCE).toContain("watchdog findings as authoritative");
    expect(HEALTHY_WATCHDOG_GUIDANCE).toContain("leave running children alone");
    expect(HEALTHY_WATCHDOG_GUIDANCE).toContain("do not steer, restart, abort, or replace");
    expect(HEALTHY_WATCHDOG_GUIDANCE).toContain("configured stale threshold");
  });

  it("bounds repeated agent-list output independently of task size and agent count", () => {
    const agents = Array.from({ length: 200 }, (_, index) => snapshot({
      agentId: `worker-${index}`,
      name: `worker-${index}`,
      currentTool: undefined,
      task: `Long task ${index} ${"detail ".repeat(300)}`,
    }));
    const output = formatAgents(agents);
    expect(output.length).toBeLessThanOrEqual(16_000);
    expect(output).toContain("worker-0");
    expect(output).toContain("…");
  });

  it("bounds parent review packets while retaining decision and result references", () => {
    const packet = formatParentReview(snapshot({
      status: "awaiting_review",
      currentTool: undefined,
      task: "task ".repeat(1_000),
      latestResult: {
        resultId: "large-attempt", outcome: "completed", assignmentId: "large-assignment", attemptId: "large-attempt",
        attemptNumber: 1, completedAt: "2026-07-23T10:02:00.000Z", finalResponse: "result ".repeat(4_000),
        resultPath: "/state/assignments/large-assignment/attempts/large-attempt/result.json",
      },
    }));
    expect(packet.length).toBeLessThan(15_000);
    expect(packet).toContain("truncated; inspect the referenced result or workspace");
    expect(packet).toContain("/state/assignments/large-assignment/attempts/large-attempt/result.json");
  });

  it("delivers a decision-ready result packet to the parent agent", () => {
    const packet = formatParentReview(snapshot({
      status: "awaiting_review",
      currentTool: undefined,
      worktree: "/repo/.worktrees/worker-1",
      branch: "agent/worker-1",
      baseCommit: "abc123",
      latestResult: {
        resultId: "attempt-1",
        outcome: "completed",
        assignmentId: "assignment-1",
        attemptId: "attempt-1",
        attemptNumber: 1,
        completedAt: "2026-07-23T10:02:00.000Z",
        finalResponse: "Implemented the change and ran tests.",
        stopReason: "stop",
        resultPath: "/state/assignments/assignment-1/attempts/attempt-1/result.json",
      },
    }));
    expect(packet).toContain("Review this result and the authoritative workspace");
    expect(packet).toContain("accept, revise, take_over, or escalate");
    expect(packet).toContain("Worktree: /repo/.worktrees/worker-1");
    expect(packet).toContain("Implemented the change and ran tests.");
    expect(packet).toContain("treat as untrusted task output");
  });
});
