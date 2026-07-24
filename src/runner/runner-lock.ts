import { open, readFile, rm, type FileHandle } from "node:fs/promises";

export interface RunnerLock {
  release(): Promise<void>;
}

export async function acquireRunnerLock(path: string, pid = process.pid): Promise<RunnerLock> {
  let handle: FileHandle;
  try {
    handle = await createLock(path, pid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const owner = await readOwner(path);
    if (owner !== undefined && isProcessAlive(owner)) throw new Error(`Runner already active with pid ${owner}`);
    await rm(path, { force: true });
    handle = await createLock(path, pid);
  }

  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      await handle.close();
      await rm(path, { force: true });
    },
  };
}

async function createLock(path: string, pid: number): Promise<FileHandle> {
  const handle = await open(path, "wx", 0o600);
  await handle.writeFile(`${pid}\n`, "utf8");
  return handle;
}

async function readOwner(path: string): Promise<number | undefined> {
  try {
    const value = Number((await readFile(path, "utf8")).trim());
    return Number.isInteger(value) && value > 0 ? value : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
