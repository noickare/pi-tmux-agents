import { describe, expect, it } from "vitest";
import { parseNewAgentTask } from "../src/extension/index.js";

describe("/agents command parsing", () => {
  it("preserves the first word of an inline new-agent task", () => {
    expect(parseNewAgentTask("Create", ["agent-output.txt", "now"])).toBe("Create agent-output.txt now");
    expect(parseNewAgentTask(undefined, [])).toBe("");
  });
});
