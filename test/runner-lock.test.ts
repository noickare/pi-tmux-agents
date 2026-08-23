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
    await writeFile(path, "not-a-lock\n", "utf8");
    const lock = await acquireRunnerLock(path, 12345);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ pid: 12345, token: expect.any(String) });
    await lock.release();
  });

  it("ignores a reused live pid from an earlier boot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-runner-lock-boot-"));
    directories.push(directory);
    const path = join(directory, "runner.lock");
    const bootTime = Date.now();
    await writeFile(path, `${JSON.stringify({ pid: process.pid, bootTime: bootTime - 24 * 60 * 60_000, token: "old-boot" })}\n`, "utf8");
    const lock = await acquireRunnerLock(path, process.pid, bootTime);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ pid: process.pid, bootTime, token: expect.not.stringContaining("old-boot") });
    await lock.release();
  });

  it("allows only one concurrent stale-lock claimant", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-runner-lock-race-"));
    directories.push(directory);
    const path = join(directory, "runner.lock");
    await writeFile(path, "stale\n", "utf8");
    const attempts = await Promise.allSettled([
      acquireRunnerLock(path, process.pid),
      acquireRunnerLock(path, process.pid),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    const acquired = attempts.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireRunnerLock>>> => result.status === "fulfilled");
    await acquired?.value.release();
  });
});
