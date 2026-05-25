import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { getRuntimeConfig } from "../config/config.js";
import { redactSensitiveText } from "../logging/redact.js";
import {
  buildSessionEntry,
  extractSessionText as extractSessionTextForExport,
  listSessionFilesForAgent,
  type SessionFileEntry,
} from "../memory-host-sdk/engine-qmd.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { hasInterSessionUserProvenance } from "../sessions/input-provenance.js";

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
  sources?: SessionSummarySource[];
};

type SessionSummarySource =
  | {
      kind: "image";
    }
  | {
      kind: "resource";
      uri?: string;
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
  entry?: SessionFileEntry;
  summarize?: (text: string, model: string) => Promise<string>;
  writer?: (relPath: string, body: string) => Promise<void>;
  model?: string;
  extractAttachmentText?: (
    blocks: unknown[],
    deps?: ExtractAttachmentDeps,
  ) => Promise<{ text: string; unsupported: string[] }>;
  attachmentDeps?: ExtractAttachmentDeps;
  analysis?: SessionExportAnalysis;
};

type SessionExportAnalysis = {
  blocks: unknown[];
  effectiveHash: string;
  sources: SessionSummarySource[];
  hasContent: boolean;
};

const DEFAULT_SUMMARY_MODEL = "deepseek/deepseek-v4-flash";
const RENAME_MAX_RETRIES = 3;
const RENAME_BASE_DELAY_MS = 50;

function redactForExport(text: string): string {
  return redactSensitiveText(text, { mode: "tools" });
}

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

export type ExtractAttachmentDeps = {
  describeImage?: (filePath: string) => Promise<string>;
  stagingDir?: string;
  redact?: (text: string) => string;
};

/** Map a mimeType like "image/png" to a short file extension. */
function imageExtFromMimeType(mimeType: string): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") return "jpg";
  if (mimeType === "image/gif") return "gif";
  if (mimeType === "image/webp") return "webp";
  return "bin";
}

async function defaultDescribeImage(filePath: string): Promise<string> {
  const result = spawnSync(
    "node",
    [
      "dist/index.js",
      "infer",
      "image",
      "describe",
      "--file",
      filePath,
      "--model",
      "openai-codex/gpt-5.4-mini",
      "--json",
    ],
    {
      cwd: resolveInferCliCwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      typeof result.stderr === "string" && result.stderr.trim() !== ""
        ? result.stderr.trim()
        : `infer image describe failed with status ${result.status ?? "unknown"}`,
    );
  }
  const parsed = JSON.parse(result.stdout || "{}") as {
    outputs?: Array<{ text?: unknown }>;
  };
  const outputText = parsed.outputs?.find((output) => typeof output.text === "string")?.text;
  if (typeof outputText !== "string") {
    throw new Error("infer image describe did not return a string text output");
  }
  return outputText;
}

export async function extractAttachmentText(
  blocks: unknown[],
  deps: ExtractAttachmentDeps = {},
): Promise<{ text: string; unsupported: string[] }> {
  const redact = deps.redact ?? redactForExport;
  const describeImage = deps.describeImage ?? defaultDescribeImage;
  const stagingDir =
    deps.stagingDir ??
    path.join(
      resolveWorkspaceDir(undefined, process.env[MEMORY_WORKSPACE_DIR_ENV], existsSync),
      "raw",
      ".staging",
    );

  const parts: string[] = [];
  const unsupported: string[] = [];

  for (const block of blocks) {
    // Skip non-objects and entries without a string type field
    if (block === null || typeof block !== "object") {
      continue;
    }
    const b = block as Record<string, unknown>;
    if (typeof b["type"] !== "string") {
      continue;
    }
    const type = b["type"];

    if (type === "text") {
      // Already handled by buildSessionEntry — skip
      continue;
    }

    if (type === "resource") {
      // Treat any resource with inline string text as text-bearing content, even if mimeType is absent.
      const resource = b["resource"];
      if (
        resource !== null &&
        typeof resource === "object" &&
        typeof (resource as Record<string, unknown>)["text"] === "string"
      ) {
        const r = resource as Record<string, unknown>;
        const uri = typeof r["uri"] === "string" ? r["uri"] : undefined;
        const label = uri !== undefined ? `[resource: ${redact(uri)}]` : `[resource]`;
        const rawText = r["text"] as string;
        parts.push(`${label}\n${redact(rawText)}`);
        continue;
      }
      // Resource block that doesn't match the text/ + text criteria falls through to unsupported
      unsupported.push(type);
      parts.push(`[unsupported attachment: ${type} — referenced, not extracted]`);
      continue;
    }

    if (type === "image") {
      const mimeType =
        typeof b["mimeType"] === "string" ? b["mimeType"] : "application/octet-stream";
      const data = typeof b["data"] === "string" ? b["data"] : "";
      const ext = imageExtFromMimeType(mimeType);
      await fs.mkdir(stagingDir, { recursive: true });
      const tempFile = path.join(stagingDir, `${crypto.randomUUID()}.${ext}`);
      await fs.writeFile(tempFile, Buffer.from(data, "base64"));
      try {
        const description = await describeImage(tempFile);
        parts.push(`[image: ${redact(description)}]`);
      } catch {
        unsupported.push(type);
        parts.push(`[unsupported attachment: ${type} — referenced, not extracted]`);
      } finally {
        await fs.unlink(tempFile).catch(() => {});
      }
      continue;
    }

    // Anything else — audio, video, PDF resource, unknown
    unsupported.push(type);
    parts.push(`[unsupported attachment: ${type} — referenced, not extracted]`);
  }

  return { text: parts.join("\n"), unsupported };
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

async function collectSessionAttachmentBlocks(sessionPath: string): Promise<{
  blocks: unknown[];
  sources: SessionSummarySource[];
}> {
  const blocks: unknown[] = [];
  const sources: SessionSummarySource[] = [];
  let raw: string;
  try {
    raw = await fs.readFile(sessionPath, "utf8");
  } catch {
    return { blocks, sources };
  }

  for (const line of raw.split("\n")) {
    if (line.trim() === "") {
      continue;
    }

    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    if (
      !record ||
      typeof record !== "object" ||
      (record as { type?: unknown }).type !== "message"
    ) {
      continue;
    }

    const message = (record as { message?: unknown }).message;
    if (!message || typeof message !== "object") {
      continue;
    }

    const role = (message as { role?: unknown }).role;
    const content = (message as { content?: unknown }).content;
    if ((role !== "user" && role !== "assistant") || !Array.isArray(content)) {
      continue;
    }
    if (role === "user" && hasInterSessionUserProvenance(message)) {
      continue;
    }
    const hasTextBlock = content.some(
      (block) =>
        block !== null &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    );
    if (hasTextBlock && extractSessionTextForExport(content, role) === null) {
      continue;
    }

    for (const block of content) {
      blocks.push(block);
      if (!block || typeof block !== "object") {
        continue;
      }
      const type = (block as { type?: unknown }).type;
      if (type === "image") {
        sources.push({ kind: "image" });
        continue;
      }
      if (type === "resource") {
        const resource = (block as { resource?: unknown }).resource;
        sources.push({
          kind: "resource",
          ...(resource &&
          typeof resource === "object" &&
          typeof (resource as { uri?: unknown }).uri === "string"
            ? { uri: redactForExport((resource as { uri: string }).uri) }
            : {}),
        });
      }
    }
  }

  return { blocks, sources };
}

function sessionUuidFromEntry(entry: SessionFileEntry): string {
  const match = entry.path.match(/([^/]+?)(?:\.jsonl(?:\..+)?)?$/);
  return match?.[1] ?? entry.path;
}

function computeEffectiveSessionHash(entryHash: string, attachmentFingerprint: string): string {
  if (attachmentFingerprint === "[]") {
    return entryHash;
  }
  return crypto
    .createHash("sha256")
    .update(entryHash)
    .update("\n")
    .update(attachmentFingerprint)
    .digest("hex");
}

function buildAttachmentFingerprint(blocks: unknown[]): string {
  const normalizedBlocks = blocks.flatMap((block) => {
    if (!block || typeof block !== "object") {
      return [];
    }

    const typedBlock = block as Record<string, unknown>;
    if (typedBlock["type"] === "text") {
      return [];
    }

    if (typedBlock["type"] === "image") {
      return [
        {
          type: "image",
          mimeType:
            typeof typedBlock["mimeType"] === "string"
              ? typedBlock["mimeType"]
              : "application/octet-stream",
          dataSha256: crypto
            .createHash("sha256")
            .update(typeof typedBlock["data"] === "string" ? typedBlock["data"] : "")
            .digest("hex"),
        },
      ];
    }

    if (typedBlock["type"] === "resource") {
      const resource =
        typedBlock["resource"] !== null && typeof typedBlock["resource"] === "object"
          ? (typedBlock["resource"] as Record<string, unknown>)
          : null;
      return [
        {
          type: "resource",
          ...(typeof resource?.["uri"] === "string"
            ? { uri: redactForExport(resource["uri"]) }
            : {}),
          ...(typeof resource?.["mimeType"] === "string" ? { mimeType: resource["mimeType"] } : {}),
          ...(typeof resource?.["text"] === "string"
            ? { text: redactForExport(resource["text"]) }
            : {}),
        },
      ];
    }

    return [{ type: typedBlock["type"] }];
  });

  return JSON.stringify(normalizedBlocks);
}

function blocksHaveNonText(blocks: unknown[]): boolean {
  return blocks.some(
    (block) =>
      block !== null &&
      typeof block === "object" &&
      typeof (block as { type?: unknown }).type === "string" &&
      (block as { type?: unknown }).type !== "text",
  );
}

/**
 * Cheap pre-export analysis: collect attachment blocks and compute the
 * change-detection hash + provenance WITHOUT running any extraction (no vision
 * describe / transcription). The export loop uses this to apply the
 * incremental-skip and dry-run gates before paying for expensive extraction.
 */
async function analyzeSessionForExport(
  sessionPath: string,
  entry: SessionFileEntry,
): Promise<SessionExportAnalysis> {
  const { blocks, sources } = await collectSessionAttachmentBlocks(sessionPath);
  const attachmentFingerprint = buildAttachmentFingerprint(blocks);
  return {
    blocks,
    effectiveHash: computeEffectiveSessionHash(entry.hash, attachmentFingerprint),
    sources,
    hasContent: entry.content.trim() !== "" || blocksHaveNonText(blocks),
  };
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
  const entry = options.entry ?? (await buildEntry(sessionPath));

  if (!entry || entry.generatedByDreamingNarrative || entry.generatedByCronRun) {
    return null;
  }

  const analysis = options.analysis ?? (await analyzeSessionForExport(sessionPath, entry));
  if (!analysis.hasContent) {
    return null;
  }

  const attachmentText =
    analysis.blocks.length > 0
      ? (
          await (options.extractAttachmentText ?? extractAttachmentText)(
            analysis.blocks,
            options.attachmentDeps,
          )
        ).text.trim()
      : "";
  const summaryInput = [entry.content.trim(), attachmentText].filter(Boolean).join("\n");
  if (summaryInput.length === 0) {
    return null;
  }

  const summary = await (options.summarize ?? summarize)(
    summaryInput,
    options.model ?? DEFAULT_SUMMARY_MODEL,
  );
  return {
    hash: analysis.effectiveHash,
    mtimeMs: entry.mtimeMs,
    summary,
    ...(analysis.sources.length > 0 ? { sources: analysis.sources } : {}),
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
    if (!entry) {
      skipped++;
      continue;
    }
    if (entry.generatedByDreamingNarrative || entry.generatedByCronRun) {
      skipped++;
      continue;
    }

    // Cheap analysis: change-detection hash + provenance with NO attachment
    // extraction, so the skip/dry-run gates run before any expensive vision work.
    const analysis = await analyzeSessionForExport(file, entry);
    if (!analysis.hasContent) {
      skipped++;
      continue;
    }

    if (!shouldExport({ ...entry, hash: analysis.effectiveHash }, state, opts.force)) {
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
      // Extraction (vision describe, etc.) happens exactly once here, only for
      // sessions that actually need exporting. Redact-before-summarize preserved.
      const result = await exportOneSession(file, {
        buildEntry: buildEntryFn,
        entry,
        summarize: summarizeFn,
        model: opts.model,
        attachmentDeps: { stagingDir },
        analysis,
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
