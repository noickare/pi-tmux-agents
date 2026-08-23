import { randomUUID } from "node:crypto";
import { link, readFile, rename, rm, writeFile } from "node:fs/promises";
import { uptime } from "node:os";

export interface RunnerLock {
  release(): Promise<void>;
}

interface LockOwner {
  pid: number;
  bootTime: number;
  token: string;
}

const BOOT_TIME_TOLERANCE_MS = 10_000;

export async function acquireRunnerLock(path: string, pid = process.pid, bootTime = currentBootTime()): Promise<RunnerLock> {
  let owner: LockOwner;
  while (true) {
    try {
      owner = await createLock(path, pid, bootTime);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readOwner(path);
      if (existing && sameBoot(existing.bootTime, bootTime) && isProcessAlive(existing.pid)) {
        throw new Error(`Runner already active with pid ${existing.pid}`);
      }
      const stalePath = `${path}.stale-${pid}-${randomUUID()}`;
      try {
        await rename(path, stalePath);
      } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw renameError;
      }
      await rm(stalePath, { force: true });
    }
  }

  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      const current = await readOwner(path);
      if (current?.token === owner.token) await rm(path, { force: true });
    },
  };
}

async function createLock(path: string, pid: number, bootTime: number): Promise<LockOwner> {
  const owner = { pid, bootTime, token: randomUUID() };
  const temporary = `${path}.${pid}.${owner.token}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(owner)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await link(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return owner;
}

async function readOwner(path: string): Promise<LockOwner | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (!value || typeof value !== "object") return undefined;
  const owner = value as Partial<LockOwner>;
  return Number.isInteger(owner.pid) && Number(owner.pid) > 0 && typeof owner.bootTime === "number" && Number.isFinite(owner.bootTime) && typeof owner.token === "string" && owner.token.length > 0
    ? owner as LockOwner
    : undefined;
}

function currentBootTime(): number {
  return Date.now() - uptime() * 1_000;
}

function sameBoot(left: number, right: number): boolean {
  return Math.abs(left - right) <= BOOT_TIME_TOLERANCE_MS;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
