import { describe, expect, it } from "vitest";
import type { AcpRuntimeEvent } from "../../acp/runtime/types.js";
import { curateAcpRuntimeEvents } from "./acp-drive-curation.js";

describe("curateAcpRuntimeEvents", () => {
  it("coalesces output deltas into a single reply on done", () => {
    const events: AcpRuntimeEvent[] = [
      { type: "text_delta", text: "First " },
      { type: "text_delta", text: "reply." },
      { type: "done" },
    ];

    expect(curateAcpRuntimeEvents(events)).toEqual([
      {
        kind: "codex-reply",
        text: "First reply.",
      },
    ]);
  });

  it("drops status, tool calls, thought deltas, and partial output before done", () => {
    const events: AcpRuntimeEvent[] = [
      { type: "status", text: "running" },
      { type: "tool_call", text: "read file", status: "started" },
      { type: "text_delta", text: "hidden", stream: "thought" },
      { type: "text_delta", text: "visible partial" },
    ];

    expect(curateAcpRuntimeEvents(events)).toEqual([]);
  });

  it("maps runtime errors into a curated error note", () => {
    expect(curateAcpRuntimeEvents([{ type: "error", message: "boom", code: "E_TEST" }])).toEqual([
      {
        kind: "codex-reply",
        text: "ACP session error: boom",
      },
    ]);
  });

  it("deduplicates already surfaced turn ids", () => {
    const surfacedTurnIds = new Set(["turn-1"]);

    expect(
      curateAcpRuntimeEvents([{ type: "text_delta", text: "Duplicate" }, { type: "done" }], {
        turnId: "turn-1",
        surfacedTurnIds,
      }),
    ).toEqual([]);
    expect(
      curateAcpRuntimeEvents([{ type: "text_delta", text: "New" }, { type: "done" }], {
        turnId: "turn-2",
        surfacedTurnIds,
      }),
    ).toEqual([{ kind: "codex-reply", text: "New" }]);
    expect([...surfacedTurnIds].sort()).toEqual(["turn-1", "turn-2"]);
  });

  it("preserves reply order across completed turns", () => {
    const events: AcpRuntimeEvent[] = [
      { type: "text_delta", text: "One" },
      { type: "done" },
      { type: "text_delta", text: "Two" },
      { type: "done" },
    ];

    expect(curateAcpRuntimeEvents(events)).toEqual([
      { kind: "codex-reply", text: "One" },
      { kind: "codex-reply", text: "Two" },
    ]);
  });
});
