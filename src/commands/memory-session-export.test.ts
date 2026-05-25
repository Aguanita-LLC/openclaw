import { describe, expect, it, vi } from "vitest";
import { exportOneSession } from "./memory-session-export.js";

describe("exportOneSession", () => {
  it("only the redacted entry text reaches the summarizer", async () => {
    const summarize = vi.fn(async () => "SUMMARY");
    const buildEntry = vi.fn(async () => ({
      content: "User: token sk-…masked\nAssistant: ok",
      hash: "h1",
      mtimeMs: 1,
    }));

    await exportOneSession("/tmp/s.jsonl", { summarize, buildEntry, writer: vi.fn() });

    const sent = summarize.mock.calls[0]?.[0] as string;
    expect(sent).toContain("sk-…masked");
    expect(sent).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
  });
});
