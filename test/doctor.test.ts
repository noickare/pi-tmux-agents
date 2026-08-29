import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandRunner } from "../src/services/command-runner.js";
import { AgentsDoctor } from "../src/services/doctor.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("AgentsDoctor", () => {
  it("reports Pi patch versions below the supported baseline", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "pi-doctor-version-"));
    dirs.push(stateRoot);
    const run = vi.fn<CommandRunner>().mockImplementation(async (command, args) => {
      if (command === "tmux" && args[0] === "-V") return { stdout: "tmux 3.5\n", stderr: "", code: 0 };
      if (command === "git" && args[0] === "--version") return { stdout: "git version 2.45.0\n", stderr: "", code: 0 };
      if (command === "pi" && args[0] === "--version") return { stdout: "0.84.3\n", stderr: "", code: 0 };
      if (command === "tmux" && args[0] === "show-options") return { stdout: "on\n", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    });

    const checks = await new AgentsDoctor(run).check(stateRoot);
    expect(checks.find((check) => check.name === "pi")).toMatchObject({
      ok: false,
      detail: "0.84.3",
      remediation: expect.stringContaining("0.84.4"),
    });
  });

  it("reports actionable tmux configuration without mutating it", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "pi-doctor-"));
    dirs.push(stateRoot);
    const run = vi.fn<CommandRunner>().mockImplementation(async (command, args) => {
      if (command === "tmux" && args[0] === "show-options") return { stdout: "off\n", stderr: "", code: 0 };
      if (command === "tmux" && args[0] === "-V") return { stdout: "tmux 3.5\n", stderr: "", code: 0 };
      if (command === "git" && args[0] === "--version") return { stdout: "git version 2.45.0\n", stderr: "", code: 0 };
      if (command === "pi" && args[0] === "--version") return { stdout: "0.84.4\n", stderr: "", code: 0 };
      return { stdout: `${command} version\n`, stderr: "", code: 0 };
    });
    const checks = await new AgentsDoctor(run).check(stateRoot);
    expect(checks.find((check) => check.name === "pi")).toMatchObject({ ok: true, detail: "0.84.4" });
    expect(checks.find((check) => check.name === "tmux extended-keys")).toMatchObject({ ok: false });
    expect(checks.find((check) => check.name === "state directory")).toMatchObject({ ok: true });
    expect(run.mock.calls.every((call) => !["set-option", "source-file"].includes(call[1][0] ?? ""))).toBe(true);
  });
});
