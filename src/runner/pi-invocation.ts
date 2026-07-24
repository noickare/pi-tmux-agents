import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentJob } from "./job.js";
import type { PiRpcProcessOptions } from "./pi-rpc-process.js";

export async function buildPiRpcOptions(job: AgentJob): Promise<PiRpcProcessOptions> {
  const sessionDirectory = join(job.stateDirectory, "sessions");
  await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
  const args = [
    "--mode", "rpc",
    "--session-dir", sessionDirectory,
    "--session-id", job.sessionId,
    "--name", job.name,
    "--no-extensions",
    job.approveProject ? "--approve" : "--no-approve",
  ];
  if (job.model) args.push("--model", job.model);
  if (job.tools?.length) args.push("--tools", job.tools.join(","));
  if (job.systemPrompt?.trim()) {
    const promptPath = join(job.stateDirectory, "system-prompt.md");
    await writeFile(promptPath, job.systemPrompt, { encoding: "utf8", mode: 0o600 });
    args.push("--append-system-prompt", promptPath);
  }
  return {
    command: process.env.PI_BINARY || "pi",
    args,
    cwd: job.cwd,
    onStderr: (text) => process.stderr.write(text),
  };
}
