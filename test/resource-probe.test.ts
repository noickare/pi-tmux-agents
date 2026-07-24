import { describe, expect, it, vi } from "vitest";
import type { CommandRunner } from "../src/services/command-runner.js";
import { ResourceProbe } from "../src/services/resource-probe.js";

describe("ResourceProbe", () => {
  it("reads available disk bytes without shell interpolation", async () => {
    const run = vi.fn<CommandRunner>().mockResolvedValue({
      stdout: "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk 1000 250 750 25% /tmp\n",
      stderr: "",
      code: 0,
    });
    const result = await new ResourceProbe(run).snapshot("/tmp", { parentReservedCpu: 2 });
    expect(result.availableDiskBytes).toBe(750 * 1024);
    expect(result.parentReservedCpu).toBe(2);
    expect(run).toHaveBeenCalledWith("df", ["-Pk", "/tmp"]);
  });
});
