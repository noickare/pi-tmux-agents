export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
  killed?: boolean;
}

export interface RunOptions {
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
}

export type CommandRunner = (command: string, args: readonly string[], options?: RunOptions) => Promise<CommandResult>;

export function requireSuccess(result: CommandResult, description: string): CommandResult {
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
    throw new Error(`${description} failed: ${detail}`);
  }
  return result;
}
