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
});
