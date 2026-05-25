import { buildSessionEntry, type SessionFileEntry } from "../memory-host-sdk/engine-qmd.js";

export type MemorySessionExportOptions = {
  dryRun: boolean;
  force: boolean;
  model: string;
};

type SessionSummary = {
  hash: string;
  mtimeMs: number;
  summary: string;
};

export type ExportOneSessionOptions = {
  buildEntry?: (p: string) => Promise<SessionFileEntry | null>;
  summarize?: (text: string, model: string) => Promise<string>;
  writer?: (relPath: string, body: string) => Promise<void>;
  model?: string;
};

const DEFAULT_SUMMARY_MODEL = "deepseek/deepseek-v4-flash";

export async function exportOneSession(
  sessionPath: string,
  options: ExportOneSessionOptions = {},
): Promise<SessionSummary | null> {
  const buildEntry = options.buildEntry ?? buildSessionEntry;
  const entry = await buildEntry(sessionPath);

  if (!entry || entry.content.trim().length === 0) {
    return null;
  }

  const summary = await options.summarize!(entry.content, options.model ?? DEFAULT_SUMMARY_MODEL);
  return {
    hash: entry.hash,
    mtimeMs: entry.mtimeMs,
    summary,
  };
}

export async function runMemorySessionExportCommand(_opts: MemorySessionExportOptions) {
  return { exported: 0, skipped: 0 };
}
