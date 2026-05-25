import type { Command } from "commander";
import { runMemorySessionExportCommand } from "../commands/memory-session-export.js";

export function registerMemoryCli(program: Command) {
  const memory = program.command("memory").description("Memory maintenance commands");

  memory
    .command("session-export")
    .description("Summarize sessions into the permanent daily archive")
    .option("--dry-run", "Scan and report without writing", false)
    .option("--force", "Re-export all sessions regardless of hash", false)
    .option("--model <provider/model>", "Summarization model", "deepseek/deepseek-v4-flash")
    .action(async (opts) => {
      await runMemorySessionExportCommand({
        dryRun: !!opts.dryRun,
        force: !!opts.force,
        model: opts.model,
      });
    });
}
