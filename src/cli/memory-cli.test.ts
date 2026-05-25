import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

vi.mock("../commands/memory-session-export.js", () => ({
  runMemorySessionExportCommand: vi.fn(async () => ({ exported: 0, skipped: 0 })),
}));

describe("memory cli", () => {
  it("wires `memory session-export --dry-run`", async () => {
    const { runMemorySessionExportCommand } = await import("../commands/memory-session-export.js");
    const { registerMemoryCli } = await import("./memory-cli.js");
    const program = new Command();

    registerMemoryCli(program);
    await program.parseAsync(["memory", "session-export", "--dry-run"], { from: "user" });

    expect(runMemorySessionExportCommand).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true }),
    );
  });

  it("registers memory through core subcli wiring", async () => {
    const [{ registerSubCliByName }, { getSubCliEntries, getSubCliCommandsWithSubcommands }] =
      await Promise.all([
        import("./program/register.subclis-core.js"),
        import("./program/subcli-descriptors.js"),
      ]);
    const program = new Command();

    expect(getSubCliEntries().some((descriptor) => descriptor.name === "memory")).toBe(true);
    expect(getSubCliCommandsWithSubcommands()).toContain("memory");
    await expect(registerSubCliByName(program, "memory")).resolves.toBe(true);
    expect(program.commands.some((command) => command.name() === "memory")).toBe(true);
  });
});
