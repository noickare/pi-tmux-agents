import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireRunnerLock } from "../src/runner/runner-lock.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("runner lock", () => {
  it("rejects a second live runner", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-runner-lock-"));
    directories.push(directory);
    const path = join(directory, "runner.lock");
    const lock = await acquireRunnerLock(path);
    await expect(acquireRunnerLock(path)).rejects.toThrow("Runner already active");
    await lock.release();
  });

  it("recovers a stale or malformed lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-runner-lock-"));
    directories.push(directory);
    const path = join(directory, "runner.lock");
    await writeFile(path, "not-a-pid\n", "utf8");
    const lock = await acquireRunnerLock(path, 12345);
    expect(await readFile(path, "utf8")).toBe("12345\n");
    await lock.release();
  });
});
