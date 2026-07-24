import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverAgents } from "../src/core/agents.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("agent discovery", () => {
  it("discovers the nearest project definitions", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-agent-definitions-"));
    directories.push(root);
    const agents = join(root, ".pi", "agents");
    const nested = join(root, "packages", "app");
    await mkdir(agents, { recursive: true });
    await mkdir(nested, { recursive: true });
    await writeFile(join(agents, "worker.md"), `---\nname: worker\ndescription: General worker\ntools: read, edit\nmodel: test/model\n---\n\nWork carefully.\n`);

    const result = await discoverAgents(nested, "project");
    expect(result.projectDirectory).toBe(agents);
    expect(result.agents).toMatchObject([{ name: "worker", source: "project", tools: ["read", "edit"], model: "test/model" }]);
  });
});
