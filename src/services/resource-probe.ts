import { cpus, freemem, loadavg, totalmem } from "node:os";
import type { CommandRunner } from "./command-runner.js";
import type { ResourceSnapshot } from "./scheduler.js";

export interface ResourceProbeOptions {
  parentReservedCpu?: number;
  parentReservedMemoryBytes?: number;
  activeWeight?: number;
  providerBackoff?: boolean;
}

export class ResourceProbe {
  constructor(private readonly run: CommandRunner, private readonly platform = process.platform) {}

  async snapshot(path: string, options: ResourceProbeOptions = {}): Promise<ResourceSnapshot> {
    const activeBuildWeight = await this.activeBuildWeight();
    return {
      cpuCount: cpus().length,
      loadAverage1m: loadavg()[0] ?? 0,
      totalMemoryBytes: totalmem(),
      availableMemoryBytes: await this.availableMemory(),
      availableDiskBytes: await this.availableDisk(path),
      activeWeight: (options.activeWeight ?? 0) + activeBuildWeight,
      parentReservedCpu: options.parentReservedCpu ?? 1,
      parentReservedMemoryBytes: options.parentReservedMemoryBytes ?? 1024 ** 3,
      providerBackoff: options.providerBackoff ?? false,
    };
  }

  private async availableMemory(): Promise<number> {
    if (this.platform !== "darwin") return freemem();
    const result = await this.run("memory_pressure", ["-Q"]);
    const percentage = result.stdout.match(/System-wide memory free percentage:\s*(\d+(?:\.\d+)?)%/i)?.[1];
    const availablePercentage = Number(percentage);
    return result.code === 0 && Number.isFinite(availablePercentage)
      ? totalmem() * availablePercentage / 100
      : freemem();
  }

  private async activeBuildWeight(): Promise<number> {
    const result = await this.run("ps", ["-axo", "command="]);
    if (result.code !== 0) return 0;
    const patterns = [/\b(?:npm|pnpm|yarn|bun) (?:test|run (?:build|test|lint|check))\b/, /\b(?:cargo test|go test|pytest|vitest|jest|tsc)\b/];
    return Math.min(4, result.stdout.split("\n").filter((line) => patterns.some((pattern) => pattern.test(line))).length * 0.5);
  }

  private async availableDisk(path: string): Promise<number> {
    const result = await this.run("df", ["-Pk", path]);
    if (result.code !== 0) throw new Error(`disk probe failed: ${result.stderr.trim() || result.code}`);
    const rows = result.stdout.trim().split("\n");
    const values = rows.at(-1)?.trim().split(/\s+/);
    const availableKilobytes = Number(values?.[3]);
    if (!Number.isFinite(availableKilobytes)) throw new Error(`unexpected df output for ${path}`);
    return availableKilobytes * 1024;
  }
}
