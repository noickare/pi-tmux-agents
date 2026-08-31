import { describe, expect, it } from "vitest";
import { MainActivityTracker } from "../src/core/main-activity.js";

describe("MainActivityTracker", () => {
  it("records provider reasoning, tools, and responses in occurrence order", () => {
    let tick = 0;
    const tracker = new MainActivityTracker(() => new Date(Date.UTC(2026, 6, 23, 10, 0, tick++)));
    tracker.reset();
    tracker.agentStarted();
    tracker.turnStarted(3);
    tracker.messageUpdated({ type: "thinking_start", contentIndex: 0, partial: {} as never });
    tracker.messageUpdated({ type: "thinking_delta", contentIndex: 0, delta: "Inspect state", partial: {} as never });
    tracker.messageUpdated({ type: "thinking_end", contentIndex: 0, content: "Inspect state", partial: {} as never });
    tracker.toolStarted("read-1", "read", { path: "src/index.ts" });
    tracker.toolEnded("read-1", "read", false);
    tracker.messageUpdated({ type: "text_start", contentIndex: 1, partial: {} as never });
    tracker.messageUpdated({ type: "text_delta", contentIndex: 1, delta: "The implementation is sound.", partial: {} as never });
    tracker.messageUpdated({ type: "text_end", contentIndex: 1, content: "The implementation is sound.", partial: {} as never });

    const relevant = tracker.snapshot().timeline.filter((event) => ["reasoning", "tool", "response"].includes(event.kind));
    expect(relevant.map((event) => event.kind)).toEqual(["reasoning", "tool", "tool", "response"]);
    expect(relevant[0]).toMatchObject({ text: "Inspect state", state: "complete" });
    expect(relevant[3]).toMatchObject({ text: "The implementation is sound.", state: "complete" });
  });

  it("derives phases only from observable Pi lifecycle events", () => {
    const tracker = new MainActivityTracker(() => new Date("2026-07-23T10:00:00.000Z"));
    tracker.reset();
    expect(tracker.snapshot().phase).toBe("ready");
    tracker.agentStarted();
    expect(tracker.snapshot().phase).toBe("starting");
    tracker.turnStarted(1);
    tracker.messageUpdated({ type: "thinking_start", contentIndex: 0, partial: {} as never });
    expect(tracker.snapshot().phase).toBe("reasoning");
    tracker.toolStarted("tool-1", "bash", { command: "npm test" });
    expect(tracker.snapshot().phase).toBe("tool");
    tracker.promptStarted("confirm", "Continue?");
    expect(tracker.snapshot().phase).toBe("waiting");
    tracker.compactionStarted("threshold", true);
    expect(tracker.snapshot().phase).toBe("compacting");
    tracker.compactionFailed("threshold", false, "Too large");
    tracker.promptEnded("confirm", "Continue?");
    tracker.toolEnded("tool-1", "bash", true);
    expect(tracker.snapshot()).toMatchObject({ phase: "attention", current: "bash failed" });
    tracker.agentSettled();
    expect(tracker.snapshot()).toMatchObject({ phase: "ready", current: "Pi is ready" });
    expect(tracker.snapshot().turnIndex).toBeUndefined();
  });

  it("keeps interleaved content active until every streaming block ends", () => {
    const tracker = new MainActivityTracker(() => new Date("2026-07-23T10:00:00.000Z"));
    tracker.reset();
    tracker.agentStarted();
    tracker.turnStarted(1);
    tracker.messageUpdated({ type: "thinking_start", contentIndex: 0, partial: {} as never });
    tracker.messageUpdated({ type: "text_start", contentIndex: 1, partial: {} as never });
    tracker.messageUpdated({ type: "text_end", contentIndex: 1, content: "Visible response", partial: {} as never });
    expect(tracker.snapshot()).toMatchObject({ phase: "reasoning", current: "Provider reasoning summary is streaming" });
    tracker.messageUpdated({ type: "thinking_end", contentIndex: 0, content: "Reasoning summary", partial: {} as never });
    expect(tracker.snapshot()).toMatchObject({ phase: "continuing", current: "Reasoning summary completed" });
  });

  it("preserves a parallel tool failure after a successful sibling completes", () => {
    const tracker = new MainActivityTracker(() => new Date("2026-07-23T10:00:00.000Z"));
    tracker.reset();
    tracker.agentStarted();
    tracker.turnStarted(1);
    tracker.toolStarted("tool-1", "write", { path: "a.ts" });
    tracker.toolStarted("tool-2", "test", {});
    tracker.toolEnded("tool-1", "write", true);
    expect(tracker.snapshot()).toMatchObject({ phase: "attention", current: "test is running · write failed" });
    expect(tracker.snapshot().activeTools).toHaveLength(1);
    tracker.toolEnded("tool-2", "test", false);
    expect(tracker.snapshot()).toMatchObject({ phase: "attention", current: "write failed" });
  });

  it("returns to an active tool after a blocking Pi UI prompt closes", () => {
    const tracker = new MainActivityTracker(() => new Date("2026-07-23T10:00:00.000Z"));
    tracker.reset();
    tracker.agentStarted();
    tracker.turnStarted(1);
    tracker.toolStarted("tool-1", "extension_tool", { action: "confirm" });
    tracker.promptStarted("confirm", "Continue?");
    tracker.promptEnded("confirm", "Continue?");
    expect(tracker.snapshot()).toMatchObject({ phase: "tool", current: "extension_tool is running" });
  });
});
