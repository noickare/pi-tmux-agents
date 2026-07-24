import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandRunner } from "../src/services/command-runner.js";
import { AgentsDoctor } from "../src/services/doctor.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("AgentsDoctor", () => {
  it("reports actionable tmux configuration without mutating it", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "pi-doctor-"));
    dirs.push(stateRoot);
    const run = vi.fn<CommandRunner>().mockImplementation(async (command, args) => {
      if (command === "tmux" && args[0] === "show-options") return { stdout: "off\n", stderr: "", code: 0 };
      return { stdout: `${command} version\n`, stderr: "", code: 0 };
    });
    const checks = await new AgentsDoctor(run).check(stateRoot);
    expect(checks.find((check) => check.name === "tmux extended-keys")).toMatchObject({ ok: false });
    expect(checks.find((check) => check.name === "state directory")).toMatchObject({ ok: true });
    expect(run.mock.calls.every((call) => !["set-option", "source-file"].includes(call[1][0] ?? ""))).toBe(true);
  });
});
