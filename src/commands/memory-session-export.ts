import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
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

export type MemorySessionExportState = Record<
  string,
  {
    hash?: string;
    mtimeMs: number;
  }
>;

export type ExportOneSessionOptions = {
  buildEntry?: (p: string) => Promise<SessionFileEntry | null>;
  summarize?: (text: string, model: string) => Promise<string>;
  writer?: (relPath: string, body: string) => Promise<void>;
  model?: string;
};

const DEFAULT_SUMMARY_MODEL = "deepseek/deepseek-v4-flash";
const RENAME_MAX_RETRIES = 3;
const RENAME_BASE_DELAY_MS = 50;

function resolveStagingDir(targetAbs: string): string {
  const parsed = path.parse(targetAbs);
  const segments = targetAbs.slice(parsed.root.length).split(path.sep).filter(Boolean);
  const rawIndex = segments.lastIndexOf("raw");
  if (rawIndex >= 0) {
    return path.join(parsed.root, ...segments.slice(0, rawIndex + 1), ".staging");
  }
  return path.join(path.dirname(targetAbs), ".staging");
}

export async function atomicWrite(targetAbs: string, body: string): Promise<void> {
  const targetDir = path.dirname(targetAbs);
  const stagingDir = resolveStagingDir(targetAbs);
  const tempPath = path.join(stagingDir, `${crypto.randomUUID()}.tmp`);

  await fs.mkdir(targetDir, { recursive: true });
  await fs.mkdir(stagingDir, { recursive: true });

  const handle = await fs.open(tempPath, "w");
  try {
    await handle.writeFile(body, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  await renameWithRetry(tempPath, targetAbs);
}

async function renameWithRetry(src: string, dest: string): Promise<void> {
  for (let attempt = 0; attempt <= RENAME_MAX_RETRIES; attempt++) {
    try {
      await fs.rename(src, dest);
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "EBUSY" && attempt < RENAME_MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RENAME_BASE_DELAY_MS * 2 ** attempt));
        continue;
      }
      if (code === "EPERM" || code === "EEXIST") {
        await fs.copyFile(src, dest);
        await fs.unlink(src).catch(() => {});
        return;
      }
      throw err;
    }
  }
}

function resolveInferCliCwd(): string {
  const repoCwd = process.cwd();
  if (existsSync(path.join(repoCwd, "dist", "index.js"))) {
    return repoCwd;
  }
  if (existsSync(path.join("/app", "dist", "index.js"))) {
    return "/app";
  }
  return repoCwd;
}

async function summarize(text: string, model: string): Promise<string> {
  const result = spawnSync(
    "node",
    ["dist/index.js", "infer", "model", "run", "--model", model, "--prompt-stdin", "--json"],
    {
      cwd: resolveInferCliCwd(),
      encoding: "utf8",
      input: text,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      typeof result.stderr === "string" && result.stderr.trim() !== ""
        ? result.stderr.trim()
        : `infer model run failed with status ${result.status ?? "unknown"}`,
    );
  }
  const parsed = JSON.parse(result.stdout || "{}") as {
    outputs?: Array<{ text?: unknown }>;
  };
  const outputText = parsed.outputs?.find((output) => typeof output.text === "string")?.text;
  if (typeof outputText !== "string") {
    throw new Error("infer model run did not return a string text output");
  }
  return outputText;
}

function sessionUuidFromEntry(entry: SessionFileEntry): string {
  const match = entry.path.match(/([^/]+?)(?:\.jsonl(?:\..+)?)?$/);
  return match?.[1] ?? entry.path;
}

export function shouldExport(
  entry: SessionFileEntry,
  state: MemorySessionExportState,
  force: boolean,
): boolean {
  if (force) {
    return true;
  }

  const previous = state[sessionUuidFromEntry(entry)];
  if (!previous) {
    return true;
  }

  if (previous.hash && entry.hash) {
    return previous.hash !== entry.hash;
  }

  return previous.mtimeMs !== entry.mtimeMs;
}

export async function exportOneSession(
  sessionPath: string,
  options: ExportOneSessionOptions = {},
): Promise<SessionSummary | null> {
  const buildEntry = options.buildEntry ?? buildSessionEntry;
  const entry = await buildEntry(sessionPath);

  if (!entry || entry.content.trim().length === 0) {
    return null;
  }

  const summary = await (options.summarize ?? summarize)(
    entry.content,
    options.model ?? DEFAULT_SUMMARY_MODEL,
  );
  return {
    hash: entry.hash,
    mtimeMs: entry.mtimeMs,
    summary,
  };
}

export async function runMemorySessionExportCommand(_opts: MemorySessionExportOptions) {
  return { exported: 0, skipped: 0 };
}
