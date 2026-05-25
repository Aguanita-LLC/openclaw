import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSessionEntry } from "../memory-host-sdk/engine-qmd.js";
import { exportOneSession } from "./memory-session-export.js";

describe("exportOneSession", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-session-export-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
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

  it("throws a clear error when summarize is missing", async () => {
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

    await expect(exportOneSession(sessionPath)).rejects.toThrow(
      "exportOneSession requires a summarize dependency",
    );
  });
});
