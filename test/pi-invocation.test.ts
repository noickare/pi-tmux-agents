import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../src/core/protocol.js";
import type { AgentJob } from "../src/runner/job.js";
import { buildPiRpcOptions } from "../src/runner/pi-invocation.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("pi RPC invocation", () => {
  it("uses a persistent isolated session and disables recursive extensions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-invocation-"));
    directories.push(directory);
    const job: AgentJob = {
      protocolVersion: PROTOCOL_VERSION, parentSessionId: "parent", agentId: "worker", name: "Worker", cwd: "/repo",
      stateDirectory: directory, sessionId: "session-id", tmuxTarget: "pi-agents-parent:worker", approveProject: true,
      model: "provider/model", tools: ["read", "edit"], systemPrompt: "Work carefully.",
    };
    const options = await buildPiRpcOptions(job);
    expect(options.args).toEqual(expect.arrayContaining([
      "--mode", "rpc", "--session-id", "session-id", "--no-extensions", "--approve", "--model", "provider/model", "--tools", "read,edit",
    ]));
    const promptIndex = options.args.indexOf("--append-system-prompt");
    expect(await readFile(options.args[promptIndex + 1]!, "utf8")).toBe("Work carefully.");
  });
});
