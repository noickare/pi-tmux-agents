import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCommand } from "../src/core/protocol.js";
import { AgentStateStore } from "../src/core/state-store.js";
import { snapshot } from "./fixtures.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("AgentStateStore", () => {
  it("persists commands and atomic snapshots", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-tmux-agents-"));
    directories.push(directory);
    const store = new AgentStateStore(directory);
    const command = createCommand({ id: "command-1", agentId: "worker-1", type: "steer", payload: { message: "Continue" } });
    await store.appendCommand(command);
    await store.writeSnapshot(snapshot());

    expect((await store.readCommands()).records).toEqual([command]);
    expect(await store.readSnapshot()).toEqual(snapshot());
    expect(await readFile(store.commandsPath, "utf8")).toMatch(/command-1/);
  });

  it("recovers from a partial trailing JSONL write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-tmux-agents-"));
    directories.push(directory);
    const store = new AgentStateStore(directory);
    await store.initialize();
    const valid = createCommand({ id: "command-1", agentId: "worker-1", type: "prompt" });
    await writeFile(store.commandsPath, `${JSON.stringify(valid)}\n{"protocolVersion":`, "utf8");

    const result = await store.readCommands();
    expect(result.records).toEqual([valid]);
    expect(result.ignoredTrailingFragment).toBe(true);
  });
});
