import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
  },
  runMemorySessionExportCommand: vi.fn(async () => ({ exported: 0, skipped: 0 })),
  runCommandWithRuntime: vi.fn(
    async (
      runtime: { error: (message: string) => void; exit: (code: number) => void },
      action: () => Promise<void>,
    ) => {
      try {
        await action();
      } catch (err) {
        runtime.error(String(err));
        runtime.exit(1);
      }
    },
  ),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("../commands/memory-session-export.js", () => ({
  runMemorySessionExportCommand: mocks.runMemorySessionExportCommand,
}));

vi.mock("./cli-utils.js", () => ({
  runCommandWithRuntime: mocks.runCommandWithRuntime,
}));

describe("memory-stack cli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("wires `memory-stack session-export --dry-run`", async () => {
    const { registerMemoryStackCli } = await import("./memory-stack-cli.js");
    const program = new Command();

    registerMemoryStackCli(program);
    await program.parseAsync(["memory-stack", "session-export", "--dry-run"], { from: "user" });

    expect(mocks.runMemorySessionExportCommand).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true, force: false, model: "deepseek/deepseek-v4-flash" }),
    );
  });

  it("reports command errors through runCommandWithRuntime", async () => {
    mocks.runMemorySessionExportCommand.mockRejectedValueOnce(new Error("model offline"));
    const { registerMemoryStackCli } = await import("./memory-stack-cli.js");
    const program = new Command();
    program.exitOverride();

    registerMemoryStackCli(program);

    await expect(
      program.parseAsync(["memory-stack", "session-export", "--force"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");

    expect(mocks.runCommandWithRuntime).toHaveBeenCalledWith(
      mocks.defaultRuntime,
      expect.any(Function),
    );
    expect(mocks.defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("model offline"),
    );
    expect(mocks.defaultRuntime.exit).toHaveBeenCalledWith(1);
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
