import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { getRuntimeConfig } from "../config/config.js";
import {
  buildSessionEntry,
  listSessionFilesForAgent,
  type SessionFileEntry,
} from "../memory-host-sdk/engine-qmd.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";

// Container-side default workspace path (matches the qdrant-workspace-reconcile pattern).
const DEFAULT_MEMORY_WORKSPACE_DIR = "/home/node/.openclaw/workspace";
const MEMORY_WORKSPACE_DIR_ENV = "OPENCLAW_MEMORY_WORKSPACE_DIR";

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

export async function atomicWrite(
  targetAbs: string,
  body: string,
  stagingDir?: string,
): Promise<void> {
  const targetDir = path.dirname(targetAbs);
  const resolvedStagingDir = stagingDir ?? resolveStagingDir(targetAbs);
  const tempPath = path.join(resolvedStagingDir, `${crypto.randomUUID()}.tmp`);

  await fs.mkdir(targetDir, { recursive: true });
  await fs.mkdir(resolvedStagingDir, { recursive: true });

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
      if (code === "EPERM" || code === "EEXIST" || code === "EXDEV") {
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

export type RunMemorySessionExportDeps = {
  listSessions?: (agentId: string) => Promise<string[]>;
  buildEntry?: (p: string) => Promise<SessionFileEntry | null>;
  summarize?: (text: string, model: string) => Promise<string>;
  writeFile?: (targetAbs: string, body: string, stagingDir?: string) => Promise<void>;
  workspaceDir?: string;
  agentId?: string;
  runtime?: RuntimeEnv;
  pathExists?: (p: string) => boolean;
};

function resolveWorkspaceDir(
  overrideDir: string | undefined,
  envOverride: string | undefined,
  pathExists: (p: string) => boolean,
): string {
  if (overrideDir !== undefined) {
    return overrideDir;
  }
  if (envOverride !== undefined) {
    return envOverride;
  }
  // Use the container default when inside the container, otherwise fall back
  // to the host-side path — matching the qdrant-workspace-reconcile pattern.
  if (pathExists(DEFAULT_MEMORY_WORKSPACE_DIR)) {
    return DEFAULT_MEMORY_WORKSPACE_DIR;
  }
  return path.join(os.homedir(), ".openclaw", "workspace");
}

function formatUtcDate(ms: number): string {
  // Group sessions by the UTC calendar day of their last-modified timestamp.
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function persistState(
  statePath: string,
  dailyDir: string,
  state: MemorySessionExportState,
): Promise<void> {
  await fs.mkdir(dailyDir, { recursive: true });
  const tempStatePath = path.join(dailyDir, `${crypto.randomUUID()}.state.tmp`);
  await fs.writeFile(tempStatePath, JSON.stringify(state, null, 2), "utf8");
  await fs.rename(tempStatePath, statePath);
}

export async function runMemorySessionExportCommand(
  opts: MemorySessionExportOptions,
  deps: RunMemorySessionExportDeps = {},
): Promise<{ exported: number; skipped: number; failed: number }> {
  const pathExists = deps.pathExists ?? existsSync;
  const resolvedWorkspaceDir = resolveWorkspaceDir(
    deps.workspaceDir,
    process.env[MEMORY_WORKSPACE_DIR_ENV],
    pathExists,
  );
  const resolvedAgentId = deps.agentId ?? resolveDefaultAgentId(getRuntimeConfig());
  const runtime = deps.runtime ?? defaultRuntime;
  const listSessions = deps.listSessions ?? listSessionFilesForAgent;
  const buildEntryFn = deps.buildEntry ?? buildSessionEntry;
  const summarizeFn = deps.summarize ?? summarize;
  const writeFileFn = deps.writeFile ?? atomicWrite;

  const stagingDir = path.join(resolvedWorkspaceDir, "raw", ".staging");
  const dailyDir = path.join(resolvedWorkspaceDir, "archive", "sessions", "daily");
  const statePath = path.join(dailyDir, ".export-state.json");
  const indexPath = path.join(dailyDir, "index.md");

  // Read persisted export state (missing → empty).
  let state: MemorySessionExportState = {};
  try {
    const raw = await fs.readFile(statePath, "utf8");
    state = JSON.parse(raw) as MemorySessionExportState;
  } catch {
    // state file missing or unreadable — start fresh
  }

  // Sort for deterministic ordering (prompt-cache rule).
  const files = (await listSessions(resolvedAgentId)).slice().sort();

  let exported = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of files) {
    const entry = await buildEntryFn(file);
    if (!entry || entry.content.trim() === "") {
      skipped++;
      continue;
    }

    if (!shouldExport(entry, state, opts.force)) {
      skipped++;
      continue;
    }

    const uuid = sessionUuidFromEntry(entry);
    // Use UTC day of the session file's last-modified timestamp for archive grouping.
    const dateStr = formatUtcDate(entry.mtimeMs);

    if (opts.dryRun) {
      // Dry-run: count as a would-export candidate but write nothing and skip summarization.
      exported++;
      continue;
    }

    try {
      // Redact content and summarize.
      const result = await exportOneSession(file, {
        buildEntry: buildEntryFn,
        summarize: summarizeFn,
        model: opts.model,
      });
      if (!result) {
        skipped++;
        continue;
      }

      const docBody = `# Session ${uuid} (${dateStr})\n\n${result.summary}\n`;
      const targetPath = path.join(dailyDir, dateStr, `${uuid}.md`);
      await writeFileFn(targetPath, docBody, stagingDir);

      // Append to the permanent ledger only if this uuid is not already present.
      let indexContent = "";
      try {
        indexContent = await fs.readFile(indexPath, "utf8");
      } catch {
        // index.md does not exist yet — will be created
      }

      if (!indexContent.includes(uuid)) {
        if (indexContent === "") {
          indexContent = "# Session Archive Index\n";
        }
        indexContent += `- ${dateStr} ${uuid} -> ${dateStr}/${uuid}.md\n`;
        await fs.mkdir(dailyDir, { recursive: true });
        await fs.writeFile(indexPath, indexContent, "utf8");
      }

      state[uuid] = { hash: result.hash, mtimeMs: result.mtimeMs };
      exported++;

      // Persist state immediately after each successful session so a mid-batch
      // abort does not lose already-paid summarization work.
      await persistState(statePath, dailyDir, state);
    } catch (err) {
      runtime.error(
        `session export failed for ${file}: ${err instanceof Error ? err.message : String(err)}`,
      );
      failed++;
    }
  }

  const modeLabel = opts.dryRun ? "dry-run" : "apply";
  runtime.log(
    `Session export (${modeLabel}): exported ${exported}, skipped ${skipped}, failed ${failed}`,
  );

  return { exported, skipped, failed };
}
