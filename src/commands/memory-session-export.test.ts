import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSessionEntry, type SessionFileEntry } from "../memory-host-sdk/engine-qmd.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: vi.fn(),
  };
});

import {
  atomicWrite,
  exportOneSession,
  extractAttachmentText,
  runMemorySessionExportCommand,
  shouldExport,
} from "./memory-session-export.js";

function attachmentAwareHash(entryHash: string, attachmentText: string): string {
  return crypto
    .createHash("sha256")
    .update(entryHash)
    .update("\n")
    .update(attachmentText.trim())
    .digest("hex");
}

describe("exportOneSession", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-session-export-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.mocked(spawnSync).mockReset();
  });

  it("passes exactly the redacted default session entry content to the summarizer", async () => {
    const sessionPath = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      sessionPath,
      [
        JSON.stringify({
          type: "custom",
          customType: "ignored",
          data: { token: "sk-openai-ignore" },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: "Token sk-openai-1234567890ABCDEFGH",
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: "Safe reply",
          },
        }),
      ].join("\n"),
    );

    const entry = await buildSessionEntry(sessionPath);
    expect(entry).not.toBeNull();
    expect(entry?.content).toBe("User: Token sk-ope\u2026EFGH\nAssistant: Safe reply");

    const summarize = vi.fn(async () => "SUMMARY");

    const result = await exportOneSession(sessionPath, { summarize });

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize).toHaveBeenCalledWith(entry?.content, "deepseek/deepseek-v4-flash");
    expect(result).toEqual({
      hash: entry?.hash,
      mtimeMs: entry?.mtimeMs,
      summary: "SUMMARY",
    });
  });

  it("uses the default summarizer when summarize is not provided", async () => {
    const sessionPath = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      sessionPath,
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: "Sensitive token sk-openai-1234567890ABCDEFGH",
        },
      }),
    );

    vi.mocked(spawnSync).mockReturnValue({
      error: undefined,
      status: 0,
      stdout: JSON.stringify({
        ok: true,
        capability: "model.run",
        transport: "local",
        outputs: [
          {
            text: "SUMMARY",
            mediaUrl: null,
          },
        ],
      }),
      stderr: "",
    } as ReturnType<typeof spawnSync>);

    const entry = await buildSessionEntry(sessionPath);
    const result = await exportOneSession(sessionPath);

    expect(spawnSync).toHaveBeenCalledWith(
      "node",
      [
        "dist/index.js",
        "infer",
        "model",
        "run",
        "--model",
        "deepseek/deepseek-v4-flash",
        "--prompt-stdin",
        "--json",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        input: entry?.content,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    expect(result).toEqual({
      hash: entry?.hash,
      mtimeMs: entry?.mtimeMs,
      summary: "SUMMARY",
    });
  });

  it("folds extracted attachment text into the session document and records attachment sources", async () => {
    const sessionPath = path.join(tempDir, "session-with-attachments.jsonl");
    const imageBlock = {
      type: "image",
      mimeType: "image/png",
      data: Buffer.from("fake-image-bytes").toString("base64"),
    };
    const resourceBlock = {
      type: "resource",
      resource: {
        uri: "memory://note.md",
        mimeType: "text/markdown",
        text: "# Embedded note",
      },
    };

    await fs.writeFile(
      sessionPath,
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "See attachments" }, imageBlock, resourceBlock],
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: "I reviewed them",
          },
        }),
      ].join("\n"),
    );

    const entry = await buildSessionEntry(sessionPath);
    expect(entry).not.toBeNull();
    expect(entry?.content).toBe("User: See attachments\nAssistant: I reviewed them");

    const summarize = vi.fn(async () => "SUMMARY");
    const extractAttachmentText = vi.fn(async () => ({
      text: "[image: a terminal screenshot]\n[resource: memory://note.md]\n# Embedded note",
      unsupported: [],
    }));

    const result = await exportOneSession(sessionPath, {
      summarize,
      extractAttachmentText,
    });

    expect(extractAttachmentText).toHaveBeenCalledTimes(1);
    expect(extractAttachmentText).toHaveBeenCalledWith(
      [{ type: "text", text: "See attachments" }, imageBlock, resourceBlock],
      undefined,
    );
    expect(summarize).toHaveBeenCalledWith(
      [
        "User: See attachments",
        "Assistant: I reviewed them",
        "[image: a terminal screenshot]",
        "[resource: memory://note.md]",
        "# Embedded note",
      ].join("\n"),
      "deepseek/deepseek-v4-flash",
    );
    expect(result).toEqual({
      hash: attachmentAwareHash(
        entry?.hash ?? "",
        "[image: a terminal screenshot]\n[resource: memory://note.md]\n# Embedded note",
      ),
      mtimeMs: entry?.mtimeMs,
      summary: "SUMMARY",
      sources: [{ kind: "image" }, { kind: "resource", uri: "memory://note.md" }],
    });
  });

  it("exports attachment-only sessions when attachment extraction yields text", async () => {
    const sessionPath = path.join(tempDir, "attachment-only-session.jsonl");
    const imageBlock = {
      type: "image",
      mimeType: "image/png",
      data: Buffer.from("fake-image-bytes").toString("base64"),
    };
    const resourceBlock = {
      type: "resource",
      resource: {
        uri: "memory://attachment-only.md",
        mimeType: "text/markdown",
        text: "# Attachment-only note",
      },
    };

    await fs.writeFile(
      sessionPath,
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [imageBlock, resourceBlock],
        },
      }),
    );

    const entry = await buildSessionEntry(sessionPath);
    expect(entry).not.toBeNull();
    expect(entry?.content).toBe("");

    const summarize = vi.fn(async () => "ATTACHMENT SUMMARY");
    const extractAttachmentText = vi.fn(async () => ({
      text: "[image: extracted screenshot]\n[resource: memory://attachment-only.md]\n# Attachment-only note",
      unsupported: [],
    }));

    const result = await exportOneSession(sessionPath, {
      summarize,
      extractAttachmentText,
    });

    expect(extractAttachmentText).toHaveBeenCalledWith([imageBlock, resourceBlock], undefined);
    expect(summarize).toHaveBeenCalledWith(
      [
        "[image: extracted screenshot]",
        "[resource: memory://attachment-only.md]",
        "# Attachment-only note",
      ].join("\n"),
      "deepseek/deepseek-v4-flash",
    );
    expect(result).toEqual({
      hash: attachmentAwareHash(
        entry?.hash ?? "",
        "[image: extracted screenshot]\n[resource: memory://attachment-only.md]\n# Attachment-only note",
      ),
      mtimeMs: entry?.mtimeMs,
      summary: "ATTACHMENT SUMMARY",
      sources: [{ kind: "image" }, { kind: "resource", uri: "memory://attachment-only.md" }],
    });
  });

  it("does not append attachment text from suppressed or inter-session messages", async () => {
    const sessionPath = path.join(tempDir, "filtered-attachments-session.jsonl");
    const keptImageBlock = {
      type: "image",
      mimeType: "image/png",
      data: Buffer.from("kept-image-bytes").toString("base64"),
    };
    const suppressedResourceBlock = {
      type: "resource",
      resource: {
        uri: "memory://suppressed.md",
        mimeType: "text/markdown",
        text: "# Suppressed attachment",
      },
    };
    const interSessionResourceBlock = {
      type: "resource",
      resource: {
        uri: "memory://inter-session.md",
        mimeType: "text/markdown",
        text: "# Inter-session attachment",
      },
    };

    await fs.writeFile(
      sessionPath,
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "Keep this" }, keptImageBlock],
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: [
              { type: "text", text: "[cron:nightly] internal prompt" },
              suppressedResourceBlock,
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            provenance: { kind: "inter_session", sourceSessionKey: "source-session" },
            content: [{ type: "text", text: "Forwarded instruction" }, interSessionResourceBlock],
          },
        }),
      ].join("\n"),
    );

    const entry = await buildSessionEntry(sessionPath);
    expect(entry).not.toBeNull();
    expect(entry?.content).toBe("User: Keep this");

    const summarize = vi.fn(async () => "FILTERED SUMMARY");
    const extractAttachmentText = vi.fn(async () => ({
      text: "[image: kept screenshot]",
      unsupported: [],
    }));

    const result = await exportOneSession(sessionPath, {
      summarize,
      extractAttachmentText,
    });

    expect(extractAttachmentText).toHaveBeenCalledWith(
      [{ type: "text", text: "Keep this" }, keptImageBlock],
      undefined,
    );
    expect(summarize).toHaveBeenCalledWith(
      ["User: Keep this", "[image: kept screenshot]"].join("\n"),
      "deepseek/deepseek-v4-flash",
    );
    expect(result).toEqual({
      hash: attachmentAwareHash(entry?.hash ?? "", "[image: kept screenshot]"),
      mtimeMs: entry?.mtimeMs,
      summary: "FILTERED SUMMARY",
      sources: [{ kind: "image" }],
    });
  });
});

describe("atomicWrite", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-session-export-write-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("writes through raw/.staging and leaves only the finished target", async () => {
    const target = path.join(tempDir, "raw", "session.md");
    const openSpy = vi.spyOn(fs, "open");
    const renameSpy = vi.spyOn(fs, "rename");

    await atomicWrite(target, "session body");

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(renameSpy).toHaveBeenCalledTimes(1);

    const [openedPath, openFlags] = openSpy.mock.calls[0] ?? [];
    const [renameFrom, renameTo] = renameSpy.mock.calls[0] ?? [];
    const expectedStagingDir = path.join(tempDir, "raw", ".staging");

    expect(path.dirname(openedPath as string)).toBe(expectedStagingDir);
    expect(path.basename(openedPath as string)).toMatch(/.+\.tmp$/);
    expect(openFlags).toBe("w");
    expect(renameFrom).toBe(openedPath);
    expect(renameTo).toBe(target);

    await expect(fs.readFile(target, "utf8")).resolves.toBe("session body");
    await expect(fs.readdir(path.join(tempDir, "raw", ".staging"))).resolves.toEqual([]);

    openSpy.mockRestore();
    renameSpy.mockRestore();
  });

  it("overwrites an existing target when rename reports a Windows replace error", async () => {
    const target = path.join(tempDir, "raw", "session.md");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "old body", "utf8");

    const renameSpy = vi
      .spyOn(fs, "rename")
      .mockRejectedValueOnce(Object.assign(new Error("rename blocked"), { code: "EPERM" }));
    const copyFileSpy = vi.spyOn(fs, "copyFile");
    const unlinkSpy = vi.spyOn(fs, "unlink");

    await atomicWrite(target, "new body");

    expect(renameSpy).toHaveBeenCalledTimes(1);
    expect(copyFileSpy).toHaveBeenCalledTimes(1);
    expect(unlinkSpy).toHaveBeenCalledTimes(1);
    await expect(fs.readFile(target, "utf8")).resolves.toBe("new body");

    renameSpy.mockRestore();
    copyFileSpy.mockRestore();
    unlinkSpy.mockRestore();
  });

  it("can write the same target twice", async () => {
    const target = path.join(tempDir, "raw", "session.md");

    await atomicWrite(target, "first body");
    await atomicWrite(target, "second body");

    await expect(fs.readFile(target, "utf8")).resolves.toBe("second body");
  });

  it("falls back to copyFile+unlink when rename reports EXDEV (cross-device)", async () => {
    const target = path.join(tempDir, "raw", "session.md");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "old body", "utf8");

    const renameSpy = vi
      .spyOn(fs, "rename")
      .mockRejectedValueOnce(
        Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" }),
      );
    const copyFileSpy = vi.spyOn(fs, "copyFile");
    const unlinkSpy = vi.spyOn(fs, "unlink");

    await atomicWrite(target, "new body");

    expect(renameSpy).toHaveBeenCalledTimes(1);
    expect(copyFileSpy).toHaveBeenCalledTimes(1);
    expect(unlinkSpy).toHaveBeenCalledTimes(1);
    await expect(fs.readFile(target, "utf8")).resolves.toBe("new body");

    renameSpy.mockRestore();
    copyFileSpy.mockRestore();
    unlinkSpy.mockRestore();
  });
});

describe("shouldExport", () => {
  function makeEntry(overrides: Partial<SessionFileEntry> = {}): SessionFileEntry {
    return {
      path: "agent/sessions/123e4567-e89b-12d3-a456-426614174000.jsonl",
      absPath: "/tmp/123e4567-e89b-12d3-a456-426614174000.jsonl",
      mtimeMs: 100,
      size: 1,
      hash: "hash-a",
      content: "User: hello",
      lineMap: [1],
      messageTimestampsMs: [0],
      ...overrides,
    };
  }

  it("skips unchanged sessions, re-exports changed hashes, and force bypasses state", () => {
    const entry = makeEntry();
    const state = {
      "123e4567-e89b-12d3-a456-426614174000": {
        hash: "hash-a",
        mtimeMs: 100,
      },
    };

    expect(shouldExport(entry, state, false)).toBe(false);
    expect(shouldExport({ ...entry, hash: "hash-b" }, state, false)).toBe(true);
    expect(shouldExport(entry, state, true)).toBe(true);
  });

  it("falls back to mtime when the stored hash is unavailable", () => {
    const entry = makeEntry();
    const state = {
      "123e4567-e89b-12d3-a456-426614174000": {
        hash: "",
        mtimeMs: 100,
      },
    };

    expect(shouldExport(entry, state, false)).toBe(false);
    expect(shouldExport({ ...entry, mtimeMs: 101 }, state, false)).toBe(true);
  });
});

describe("atomicWrite (with explicit stagingDir)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-session-export-staging-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("stages temp under explicit stagingDir and final file lands at target", async () => {
    const targetDir = path.join(tempDir, "archive", "sessions", "daily", "2024-01-15");
    const target = path.join(targetDir, "uuid-abc.md");
    const stagingDir = path.join(tempDir, "raw", ".staging");

    const openSpy = vi.spyOn(fs, "open");
    const renameSpy = vi.spyOn(fs, "rename");

    await atomicWrite(target, "session body", stagingDir);

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(renameSpy).toHaveBeenCalledTimes(1);

    const [openedPath] = openSpy.mock.calls[0] ?? [];
    const [renameFrom, renameTo] = renameSpy.mock.calls[0] ?? [];

    expect(path.dirname(openedPath as string)).toBe(stagingDir);
    expect(path.basename(openedPath as string)).toMatch(/.+\.tmp$/);
    expect(renameFrom).toBe(openedPath);
    expect(renameTo).toBe(target);

    await expect(fs.readFile(target, "utf8")).resolves.toBe("session body");
    await expect(fs.readdir(stagingDir)).resolves.toEqual([]);

    openSpy.mockRestore();
    renameSpy.mockRestore();
  });
});

describe("runMemorySessionExportCommand", () => {
  let workspaceDir: string;

  function makeEntry(uuid: string, overrides: Partial<SessionFileEntry> = {}): SessionFileEntry {
    return {
      path: `agent/sessions/${uuid}.jsonl`,
      absPath: `/tmp/${uuid}.jsonl`,
      mtimeMs: 1_700_000_000_000,
      size: 42,
      hash: "hash-abc",
      content: "User: hello\nAssistant: hi",
      lineMap: [1, 2],
      messageTimestampsMs: [0, 1000],
      ...overrides,
    };
  }

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-export-cmd-"));
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("exports a changed session: writes archive file, index line, state; returns {exported:1, skipped:0, failed:0}", async () => {
    const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const entry = makeEntry(uuid);
    // mtimeMs = 1_700_000_000_000 → 2023-11-14 in UTC
    const expectedDate = "2023-11-14";

    const writtenFiles: Record<string, string> = {};
    const writeSpy = vi.fn(async (targetAbs: string, body: string) => {
      writtenFiles[targetAbs] = body;
    });
    const summarizeSpy = vi.fn(async () => "This session summary");

    const result = await runMemorySessionExportCommand(
      { dryRun: false, force: false, model: "test/model" },
      {
        listSessions: async () => [`/sessions/${uuid}.jsonl`],
        buildEntry: async () => entry,
        summarize: summarizeSpy,
        writeFile: writeSpy,
        workspaceDir,
        agentId: "main",
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      },
    );

    expect(result).toEqual({ exported: 1, skipped: 0, failed: 0 });

    // archive file written
    const archivePath = path.join(
      workspaceDir,
      "archive",
      "sessions",
      "daily",
      expectedDate,
      `${uuid}.md`,
    );
    expect(writeSpy).toHaveBeenCalledWith(
      archivePath,
      expect.stringContaining(`# Session ${uuid} (${expectedDate})`),
      path.join(workspaceDir, "raw", ".staging"),
    );
    expect(writeSpy.mock.calls[0]?.[1]).toContain("This session summary");

    // index.md appended
    const indexPath = path.join(workspaceDir, "archive", "sessions", "daily", "index.md");
    const indexContent = await fs.readFile(indexPath, "utf8");
    expect(indexContent).toContain(uuid);
    expect(indexContent).toContain(expectedDate);

    // state persisted
    const statePath = path.join(workspaceDir, "archive", "sessions", "daily", ".export-state.json");
    const stateContent = JSON.parse(await fs.readFile(statePath, "utf8")) as Record<
      string,
      { hash?: string; mtimeMs: number }
    >;
    expect(stateContent[uuid]).toEqual({ hash: entry.hash, mtimeMs: entry.mtimeMs });
  });

  it("skips an unchanged session and does not call summarize", async () => {
    const uuid = "aaaaaaaa-bbbb-cccc-dddd-ffffffffffff";
    const entry = makeEntry(uuid);

    const stateDir = path.join(workspaceDir, "archive", "sessions", "daily");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, ".export-state.json"),
      JSON.stringify({ [uuid]: { hash: entry.hash, mtimeMs: entry.mtimeMs } }),
    );

    const writeSpy = vi.fn();
    const summarizeSpy = vi.fn();

    const result = await runMemorySessionExportCommand(
      { dryRun: false, force: false, model: "test/model" },
      {
        listSessions: async () => [`/sessions/${uuid}.jsonl`],
        buildEntry: async () => entry,
        summarize: summarizeSpy,
        writeFile: writeSpy,
        workspaceDir,
        agentId: "main",
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      },
    );

    expect(result).toEqual({ exported: 0, skipped: 1, failed: 0 });
    expect(writeSpy).not.toHaveBeenCalled();
    expect(summarizeSpy).not.toHaveBeenCalled();
  });

  it("dry-run: returns {exported:1, skipped:0, failed:0} but writes nothing and does not call summarize", async () => {
    const uuid = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
    const entry = makeEntry(uuid);

    const writeSpy = vi.fn();
    const summarizeSpy = vi.fn();

    const result = await runMemorySessionExportCommand(
      { dryRun: true, force: false, model: "test/model" },
      {
        listSessions: async () => [`/sessions/${uuid}.jsonl`],
        buildEntry: async () => entry,
        summarize: summarizeSpy,
        writeFile: writeSpy,
        workspaceDir,
        agentId: "main",
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      },
    );

    expect(result).toEqual({ exported: 1, skipped: 0, failed: 0 });
    expect(summarizeSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();

    // no archive file
    const archivePath = path.join(workspaceDir, "archive", "sessions", "daily");
    await expect(fs.access(archivePath)).rejects.toThrow();
  });

  it("does not duplicate the index line on re-export", async () => {
    const uuid = "cccccccc-dddd-eeee-ffff-000000000000";
    const entry = makeEntry(uuid);
    const expectedDate = "2023-11-14";

    const writtenFiles: Record<string, string> = {};
    const writeSpy = vi.fn(async (targetAbs: string, body: string) => {
      writtenFiles[targetAbs] = body;
    });

    const deps = {
      listSessions: async () => [`/sessions/${uuid}.jsonl`],
      buildEntry: async () => entry,
      summarize: vi.fn(async () => "summary"),
      writeFile: writeSpy,
      workspaceDir,
      agentId: "main",
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    };

    // Export once (force to re-run even after state written)
    await runMemorySessionExportCommand({ dryRun: false, force: true, model: "test/model" }, deps);

    // Clear state so it would export again by default (force=true bypasses state check)
    await runMemorySessionExportCommand({ dryRun: false, force: true, model: "test/model" }, deps);

    const indexPath = path.join(workspaceDir, "archive", "sessions", "daily", "index.md");
    const indexContent = await fs.readFile(indexPath, "utf8");
    // Count ledger lines containing the uuid — must be exactly 1 (uuid appears twice per
    // line in the format "- <date> <uuid> -> <date>/<uuid>.md", so count lines not raw hits).
    const ledgerLines = indexContent.split("\n").filter((line) => line.includes(uuid));
    expect(ledgerLines.length).toBe(1);

    // Also verify the expected date appears in the index
    expect(indexContent).toContain(expectedDate);
  });

  it("failure isolation: one failing summarize does not abort the batch; resolves with failed:1 and persists state for the two successful sessions", async () => {
    const uuid1 = "11111111-1111-1111-1111-111111111111";
    const uuid2 = "22222222-2222-2222-2222-222222222222";
    const uuid3 = "33333333-3333-3333-3333-333333333333";

    const entry1 = makeEntry(uuid1);
    const entry2 = makeEntry(uuid2);
    const entry3 = makeEntry(uuid3);

    const entriesByFile: Record<string, SessionFileEntry> = {
      [`/sessions/${uuid1}.jsonl`]: entry1,
      [`/sessions/${uuid2}.jsonl`]: entry2,
      [`/sessions/${uuid3}.jsonl`]: entry3,
    };

    const writtenFiles: Record<string, string> = {};
    const writeSpy = vi.fn(async (targetAbs: string, body: string) => {
      writtenFiles[targetAbs] = body;
    });

    // summarize rejects on the 2nd session only
    const summarizeSpy = vi
      .fn()
      .mockResolvedValueOnce("Summary for session 1")
      .mockRejectedValueOnce(new Error("API timeout on session 2"))
      .mockResolvedValueOnce("Summary for session 3");

    const errorSpy = vi.fn();

    const result = await runMemorySessionExportCommand(
      { dryRun: false, force: true, model: "test/model" },
      {
        listSessions: async () => [
          `/sessions/${uuid1}.jsonl`,
          `/sessions/${uuid2}.jsonl`,
          `/sessions/${uuid3}.jsonl`,
        ],
        buildEntry: async (file: string) => entriesByFile[file] ?? null,
        summarize: summarizeSpy,
        writeFile: writeSpy,
        workspaceDir,
        agentId: "main",
        runtime: { log: vi.fn(), error: errorSpy, exit: vi.fn() },
      },
    );

    // (a) command resolves, does NOT throw
    expect(result).toEqual({ exported: 2, skipped: 0, failed: 1 });

    // (b) failed:1, other two in exported
    expect(result.exported).toBe(2);
    expect(result.failed).toBe(1);

    // (c) sessions 1 and 3 have state entries persisted on disk
    const statePath = path.join(workspaceDir, "archive", "sessions", "daily", ".export-state.json");
    const stateContent = JSON.parse(await fs.readFile(statePath, "utf8")) as Record<
      string,
      { hash?: string; mtimeMs: number }
    >;
    expect(stateContent[uuid1]).toEqual({ hash: entry1.hash, mtimeMs: entry1.mtimeMs });
    expect(stateContent[uuid3]).toEqual({ hash: entry3.hash, mtimeMs: entry3.mtimeMs });

    // (d) the failing session (uuid2) has no state entry and no archive file written
    expect(stateContent[uuid2]).toBeUndefined();

    const expectedDate = "2023-11-14";
    const archivePath2 = path.join(
      workspaceDir,
      "archive",
      "sessions",
      "daily",
      expectedDate,
      `${uuid2}.md`,
    );
    expect(writtenFiles[archivePath2]).toBeUndefined();

    // error was logged for the failing session
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toMatch(/session export failed for.*22222222/);
    expect(errorSpy.mock.calls[0]?.[0]).toMatch(/API timeout on session 2/);
  });

  it("re-exports when attachment-only content changes even if the transcript hash stays the same", async () => {
    const uuid = "dddddddd-eeee-ffff-0000-111111111111";
    const sessionPath = path.join(workspaceDir, `${uuid}.jsonl`);

    await fs.writeFile(
      sessionPath,
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [
            {
              type: "resource",
              resource: {
                uri: "memory://attachment-only.md",
                mimeType: "text/markdown",
                text: "# Attachment version 1",
              },
            },
          ],
        },
      }),
      "utf8",
    );

    const summarizeSpy = vi.fn(async (text: string) => `SUMMARY:${text}`);
    const writeSpy = vi.fn(async (_targetAbs: string, _body: string) => {});
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    const firstResult = await runMemorySessionExportCommand(
      { dryRun: false, force: false, model: "test/model" },
      {
        listSessions: async () => [sessionPath],
        summarize: summarizeSpy,
        writeFile: writeSpy,
        workspaceDir,
        agentId: "main",
        runtime,
      },
    );

    expect(firstResult).toEqual({ exported: 1, skipped: 0, failed: 0 });

    const statePath = path.join(workspaceDir, "archive", "sessions", "daily", ".export-state.json");
    const firstState = JSON.parse(await fs.readFile(statePath, "utf8")) as Record<
      string,
      { hash?: string; mtimeMs: number }
    >;
    const firstStoredHash = firstState[uuid]?.hash;
    expect(firstStoredHash).toBeTruthy();

    await fs.writeFile(
      sessionPath,
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [
            {
              type: "resource",
              resource: {
                uri: "memory://attachment-only.md",
                mimeType: "text/markdown",
                text: "# Attachment version 2",
              },
            },
          ],
        },
      }),
      "utf8",
    );

    const secondResult = await runMemorySessionExportCommand(
      { dryRun: false, force: false, model: "test/model" },
      {
        listSessions: async () => [sessionPath],
        summarize: summarizeSpy,
        writeFile: writeSpy,
        workspaceDir,
        agentId: "main",
        runtime,
      },
    );

    expect(secondResult).toEqual({ exported: 1, skipped: 0, failed: 0 });
    expect(summarizeSpy).toHaveBeenCalledTimes(2);

    const secondState = JSON.parse(await fs.readFile(statePath, "utf8")) as Record<
      string,
      { hash?: string; mtimeMs: number }
    >;
    expect(secondState[uuid]?.hash).not.toBe(firstStoredHash);
  });

  it("reuses one prepared image attachment pass across change detection, summary, and persisted state", async () => {
    const uuid = "eeeeeeee-ffff-0000-1111-222222222222";
    const sessionPath = path.join(workspaceDir, `${uuid}.jsonl`);
    const imageBlock = {
      type: "image",
      mimeType: "image/png",
      data: Buffer.from("fake-image-bytes").toString("base64"),
    };

    await fs.writeFile(
      sessionPath,
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [imageBlock],
        },
      }),
      "utf8",
    );

    const entry = await buildSessionEntry(sessionPath);
    expect(entry).not.toBeNull();

    vi.mocked(spawnSync)
      .mockReturnValueOnce({
        error: undefined,
        status: 0,
        stdout: JSON.stringify({
          outputs: [{ text: "first nondeterministic image description" }],
        }),
        stderr: "",
      } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({
        error: undefined,
        status: 0,
        stdout: JSON.stringify({
          outputs: [{ text: "second nondeterministic image description" }],
        }),
        stderr: "",
      } as ReturnType<typeof spawnSync>);

    const summarizeSpy = vi.fn(async (text: string) => `SUMMARY:${text}`);
    const previousWorkspaceEnv = process.env["OPENCLAW_MEMORY_WORKSPACE_DIR"];
    process.env["OPENCLAW_MEMORY_WORKSPACE_DIR"] = workspaceDir;

    let result: Awaited<ReturnType<typeof runMemorySessionExportCommand>>;
    try {
      result = await runMemorySessionExportCommand(
        { dryRun: false, force: false, model: "test/model" },
        {
          listSessions: async () => [sessionPath],
          summarize: summarizeSpy,
          writeFile: vi.fn(async () => {}),
          workspaceDir,
          agentId: "main",
          runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        },
      );
    } finally {
      if (previousWorkspaceEnv === undefined) {
        delete process.env["OPENCLAW_MEMORY_WORKSPACE_DIR"];
      } else {
        process.env["OPENCLAW_MEMORY_WORKSPACE_DIR"] = previousWorkspaceEnv;
      }
    }

    expect(result).toEqual({ exported: 1, skipped: 0, failed: 0 });
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(summarizeSpy).toHaveBeenCalledWith(
      "[image: first nondeterministic image description]",
      "test/model",
    );

    const statePath = path.join(workspaceDir, "archive", "sessions", "daily", ".export-state.json");
    const stateContent = JSON.parse(await fs.readFile(statePath, "utf8")) as Record<
      string,
      { hash?: string; mtimeMs: number }
    >;
    expect(stateContent[uuid]).toEqual({
      hash: attachmentAwareHash(
        entry?.hash ?? "",
        "[image: first nondeterministic image description]",
      ),
      mtimeMs: entry?.mtimeMs ?? 0,
    });
  });
});

describe("extractAttachmentText", () => {
  let stagingDir: string;

  beforeEach(async () => {
    stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-extract-attachment-"));
  });

  afterEach(async () => {
    await fs.rm(stagingDir, { recursive: true, force: true });
  });

  it("dispatches image, resource, and unknown blocks", async () => {
    const describeImage = vi.fn(async (_filePath: string) => "a terminal screenshot");

    // A resource block with text/markdown content
    const resourceBlock = {
      type: "resource",
      resource: {
        uri: "u1",
        mimeType: "text/markdown",
        text: "# Note",
      },
    };

    // An image block with minimal base64 PNG data (1x1 transparent pixel)
    const pngBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    const imageBlock = {
      type: "image",
      mimeType: "image/png",
      data: pngBytes.toString("base64"),
    };

    // An unknown/unsupported block type
    const audioBlock = {
      type: "audio",
      data: "base64audiostub",
    };

    const result = await extractAttachmentText([resourceBlock, imageBlock, audioBlock], {
      describeImage,
      stagingDir,
    });

    // Resource section appears
    expect(result.text).toContain("[resource: u1]");
    expect(result.text).toContain("# Note");

    // Image description appears
    expect(result.text).toContain("a terminal screenshot");

    // Unsupported block section appears
    expect(result.text).toContain("[unsupported attachment: audio");

    // unsupported list
    expect(result.unsupported).toEqual(["audio"]);

    // Temp image file cleaned up — staging dir should be empty
    const remaining = await fs.readdir(stagingDir);
    expect(remaining).toHaveLength(0);
  });

  it("extracts text resources even when mimeType is absent", async () => {
    const result = await extractAttachmentText(
      [
        {
          type: "resource",
          resource: {
            uri: "u-no-mime",
            text: "plain extracted text",
          },
        },
      ],
      { stagingDir },
    );

    expect(result.text).toContain("[resource: u-no-mime]");
    expect(result.text).toContain("plain extracted text");
    expect(result.unsupported).toEqual([]);
  });

  it("degrades image extraction failures to unsupported placeholders", async () => {
    const describeImage = vi.fn(async (_filePath: string) => {
      throw new Error("decode failed");
    });

    const result = await extractAttachmentText(
      [
        {
          type: "image",
          mimeType: "image/png",
          data: Buffer.from("fakeimagedata").toString("base64"),
        },
      ],
      {
        describeImage,
        stagingDir,
      },
    );

    expect(result.text).toContain("[unsupported attachment: image");
    expect(result.unsupported).toEqual(["image"]);

    const remaining = await fs.readdir(stagingDir);
    expect(remaining).toHaveLength(0);
  });

  it("redacts extracted attachment text", async () => {
    const secretToken = "sk-openai-1234567890ABCDEFGH";

    const describeImage = vi.fn(async (_filePath: string) => `screenshot: ${secretToken}`);

    const imageBlock = {
      type: "image",
      mimeType: "image/png",
      data: Buffer.from("fakeimagedata").toString("base64"),
    };

    const resourceBlock = {
      type: "resource",
      resource: {
        uri: "secret-doc",
        mimeType: "text/plain",
        text: `API key: ${secretToken}`,
      },
    };

    const result = await extractAttachmentText([imageBlock, resourceBlock], {
      describeImage,
      stagingDir,
    });

    // The live secret token must not appear in the output text
    expect(result.text).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
  });
});
