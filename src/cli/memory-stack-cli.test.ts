import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

vi.mock("../commands/memory-session-export.js", () => ({
  runMemorySessionExportCommand: vi.fn(async () => ({ exported: 0, skipped: 0 })),
}));

describe("memory-stack cli", () => {
  it("wires `memory-stack session-export --dry-run`", async () => {
    const { runMemorySessionExportCommand } = await import("../commands/memory-session-export.js");
    const { registerMemoryStackCli } = await import("./memory-stack-cli.js");
    const program = new Command();

    registerMemoryStackCli(program);
    await program.parseAsync(["memory-stack", "session-export", "--dry-run"], { from: "user" });

    expect(runMemorySessionExportCommand).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true, force: false, model: "deepseek/deepseek-v4-flash" }),
    );
  });

  it("registers memory-stack through core subcli wiring", async () => {
    const [{ registerSubCliByName }, { getSubCliEntries, getSubCliCommandsWithSubcommands }] =
      await Promise.all([
        import("./program/register.subclis-core.js"),
        import("./program/subcli-descriptors.js"),
      ]);
    const program = new Command();

    expect(getSubCliEntries().some((descriptor) => descriptor.name === "memory-stack")).toBe(true);
    expect(getSubCliCommandsWithSubcommands()).toContain("memory-stack");
    await expect(registerSubCliByName(program, "memory-stack")).resolves.toBe(true);
    expect(program.commands.some((command) => command.name() === "memory-stack")).toBe(true);
  });
});
