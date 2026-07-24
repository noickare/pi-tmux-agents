import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CommandRunner } from "./command-runner.js";

const execFileAsync = promisify(execFile);

export const localCommandRunner: CommandRunner = async (command, args, options = {}) => {
  try {
    const result = await execFileAsync(command, [...args], {
      cwd: options.cwd,
      timeout: options.timeout,
      signal: options.signal,
      encoding: "utf8",
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message,
      code: typeof failure.code === "number" ? failure.code : 1,
      killed: failure.killed ?? false,
    };
  }
};
