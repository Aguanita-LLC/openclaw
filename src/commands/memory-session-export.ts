import { buildSessionEntry } from "../memory-host-sdk/engine-qmd.js";

export type MemorySessionExportOptions = {
  dryRun: boolean;
  force: boolean;
  model: string;
};

type SessionEntry = {
  content: string;
  hash: string;
  mtimeMs: number;
};

type SessionSummary = {
  hash: string;
  mtimeMs: number;
  summary: string;
};

export type ExportOneSessionOptions = {
  buildEntry?: (p: string) => Promise<SessionEntry | null>;
  summarize?: (text: string, model: string) => Promise<string>;
  writer?: (relPath: string, body: string) => Promise<void>;
  model?: string;
};

const DEFAULT_SUMMARY_MODEL = "gpt-5.5";

async function defaultSummarize(_text: string, _model: string): Promise<string> {
  return "";
}

export async function exportOneSession(
  sessionPath: string,
  options: ExportOneSessionOptions = {},
): Promise<SessionSummary | null> {
  const buildEntry = options.buildEntry ?? buildSessionEntry;
  const summarize = options.summarize ?? defaultSummarize;
  const entry = await buildEntry(sessionPath);

  if (!entry || entry.content.trim().length === 0) {
    return null;
  }

  const summary = await summarize(entry.content, options.model ?? DEFAULT_SUMMARY_MODEL);
  return {
    hash: entry.hash,
    mtimeMs: entry.mtimeMs,
    summary,
  };
}

export async function runMemorySessionExportCommand(_opts: MemorySessionExportOptions) {
  return { exported: 0, skipped: 0 };
}
