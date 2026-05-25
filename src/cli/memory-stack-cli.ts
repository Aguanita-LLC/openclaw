import type { Command } from "commander";
import { runMemorySessionExportCommand } from "../commands/memory-session-export.js";

export function registerMemoryStackCli(program: Command) {
  const memoryStack = program
    .command("memory-stack")
    .description("Memory stack maintenance commands");

  memoryStack
    .command("session-export")
    .description("Summarize sessions into the permanent daily archive")
    .option("--dry-run", "Scan and report without writing", false)
    .option("--force", "Re-export all sessions regardless of hash", false)
    .option("--model <provider/model>", "Summarization model", "deepseek/deepseek-v4-flash")
    .action(async (opts: { dryRun?: boolean; force?: boolean; model: string }) => {
      await runMemorySessionExportCommand({
        dryRun: Boolean(opts.dryRun),
        force: Boolean(opts.force),
        model: opts.model,
      });
    });
}
