import { spawnSync } from "node:child_process";
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
  runMemorySessionExportCommand,
  shouldExport,
} from "./memory-session-export.js";

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

  it("exports a changed session: writes archive file, index line, state; returns {exported:1, skipped:0}", async () => {
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
        now: () => new Date("2023-11-15T00:00:00Z"),
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      },
    );

    expect(result).toEqual({ exported: 1, skipped: 0 });

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

    expect(result).toEqual({ exported: 0, skipped: 1 });
    expect(writeSpy).not.toHaveBeenCalled();
    expect(summarizeSpy).not.toHaveBeenCalled();
  });

  it("dry-run: returns {exported:1, skipped:0} but writes nothing and does not call summarize", async () => {
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

    expect(result).toEqual({ exported: 1, skipped: 0 });
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
});
