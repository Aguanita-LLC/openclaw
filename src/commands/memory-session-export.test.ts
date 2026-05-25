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

import { atomicWrite, exportOneSession, shouldExport } from "./memory-session-export.js";

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
        "--prompt",
        entry?.content,
        "--json",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
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
