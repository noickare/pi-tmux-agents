import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiRpcProcess } from "../src/runner/pi-rpc-process.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

const rpcFixture = String.raw`
import { appendFileSync } from "node:fs";

const logPath = process.argv[1];
const failClear = process.argv[2] === "fail-clear";
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).replace(/\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    appendFileSync(logPath, command.type + "\n");
    const clearFailed = failClear && command.type === "clear_queue";
    const response = {
      type: "response",
      command: command.type,
      success: !clearFailed,
      id: command.id,
      ...(clearFailed ? { error: "clear failed" } : {}),
      ...(command.type === "clear_queue" && !clearFailed ? { data: { steering: ["queued steering"], followUp: ["queued follow-up"] } } : {}),
    };
    process.stdout.write(JSON.stringify(response) + "\n");
  }
});
setInterval(() => {}, 1_000);
`;

describe("PiRpcProcess", () => {
  it("clears queued RPC messages before graceful shutdown aborts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-rpc-process-"));
    directories.push(directory);
    const logPath = join(directory, "commands.log");
    const rpc = new PiRpcProcess({
      command: process.execPath,
      args: ["--input-type=module", "--eval", rpcFixture, logPath],
      cwd: directory,
      requestTimeoutMs: 5_000,
    });

    await rpc.close();

    expect((await readFile(logPath, "utf8")).trim().split("\n")).toEqual(["clear_queue", "abort"]);
  });

  it("terminates without abort when graceful shutdown cannot clear the queue", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-rpc-process-"));
    directories.push(directory);
    const logPath = join(directory, "commands.log");
    const rpc = new PiRpcProcess({
      command: process.execPath,
      args: ["--input-type=module", "--eval", rpcFixture, logPath, "fail-clear"],
      cwd: directory,
      requestTimeoutMs: 5_000,
    });

    await rpc.close();

    expect((await readFile(logPath, "utf8")).trim().split("\n")).toEqual(["clear_queue"]);
  });
});
