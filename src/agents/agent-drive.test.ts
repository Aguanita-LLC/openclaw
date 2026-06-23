import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAgentDriveStateStore,
  type AgentDriveKey,
  type AgentDriveStateStore,
} from "../acp/agent-drive-state.js";
import { runAgentDrive, type AgentDriveBounds, type DriveSendResult } from "./agent-drive.js";

describe("runAgentDrive", () => {
  const key: AgentDriveKey = {
    channel: "discord",
    accountId: "default",
    thread: "thread-1",
  };
  let tmpDir: string;
  let now: number;
  let store: AgentDriveStateStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-drive-"));
    now = 1_000;
    store = createAgentDriveStateStore({
      filePath: path.join(tmpDir, "agent-drive-state.json"),
      now: () => now,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function startDrive(goal = "fix the failing test") {
    const started = store.startDrive(key, {
      goal,
      ownerSessionKey: "agent:main:discord:channel:1",
      targetSessionKey: "agent:harness:acp:binding:1",
    });
    if (started.status !== "active") {
      throw new Error("expected active drive");
    }
    return started.record;
  }

  function createBounds(overrides: Partial<AgentDriveBounds> = {}): AgentDriveBounds {
    return {
      maxTurns: 8,
      maxWallClockSec: 300,
      idleTimeoutSec: 30,
      now: vi.fn(() => now),
      ...overrides,
    };
  }

  it("surfaces the instruction before the final target reply and records the turn", async () => {
    const drive = startDrive();
    const order: string[] = [];
    const send = vi.fn(async (prompt: string): Promise<DriveSendResult> => {
      order.push(`send:${prompt}`);
      return { kind: "done", reply: "The test is fixed." };
    });
    const surface = vi.fn(async (text: string) => {
      order.push(`surface:${text}`);
    });
    const recordTurn = vi.spyOn(store, "recordTurn");
    const bounds = createBounds();

    const result = await runAgentDrive({
      key,
      goal: drive.goal,
      targetLabel: "Target",
      send,
      surface,
      bounds,
      store,
    });

    expect(order).toHaveLength(3);
    expect(order[0]).toContain("surface:🧭 Agent → Target:");
    expect(order[0]).toContain("fix the failing test");
    expect(order[1]).toContain("send:");
    expect(order[2]).toBe("surface:🧭 Target → Agent:\nThe test is fixed.");
    expect(recordTurn).toHaveBeenCalledWith(drive.id);
    expect(bounds.now).toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "completed",
      reason: "done",
      finalReply: "The test is fixed.",
      turnCount: 1,
    });
    expect(store.getActiveDrive(key)).toBeUndefined();
  });

  it("continues reply turns until send returns done", async () => {
    const drive = startDrive("finish the implementation");
    const send = vi
      .fn<(prompt: string) => Promise<DriveSendResult>>()
      .mockResolvedValueOnce({ kind: "reply", reply: "I found the failing path." })
      .mockResolvedValueOnce({ kind: "reply", reply: "I added the regression test." })
      .mockResolvedValueOnce({ kind: "done", reply: "Implementation complete." });
    const surface = vi.fn(async (_text: string) => {});
    const bounds = createBounds();

    const result = await runAgentDrive({
      key,
      goal: drive.goal,
      targetLabel: "Harness",
      send,
      surface,
      bounds,
      store,
    });

    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[1]?.[0]).toContain("I found the failing path.");
    expect(send.mock.calls[2]?.[0]).toContain("I added the regression test.");
    expect(surface.mock.calls.map(([text]) => text)).toEqual([
      expect.stringContaining("🧭 Agent → Harness:"),
      "🧭 Harness → Agent:\nI found the failing path.",
      expect.stringContaining("🧭 Agent → Harness:"),
      "🧭 Harness → Agent:\nI added the regression test.",
      expect.stringContaining("🧭 Agent → Harness:"),
      "🧭 Harness → Agent:\nImplementation complete.",
    ]);
    expect(bounds.now).toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "completed",
      reason: "done",
      finalReply: "Implementation complete.",
      turnCount: 3,
    });
  });

  it("terminates at the maximum turn count", async () => {
    const drive = startDrive();
    const send = vi.fn(
      async (): Promise<DriveSendResult> => ({
        kind: "reply",
        reply: "More work remains.",
      }),
    );

    const result = await runAgentDrive({
      key,
      goal: drive.goal,
      targetLabel: "Harness",
      send,
      surface: async () => {},
      bounds: createBounds({ maxTurns: 2 }),
      store,
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      status: "completed",
      reason: "max_turns",
      turnCount: 2,
    });
  });

  it("terminates at the maximum wall-clock duration", async () => {
    const drive = startDrive();
    const send = vi.fn(async (): Promise<DriveSendResult> => {
      now = 3_500;
      return { kind: "reply", reply: "Still working." };
    });

    const result = await runAgentDrive({
      key,
      goal: drive.goal,
      targetLabel: "Harness",
      send,
      surface: async () => {},
      bounds: createBounds({ maxWallClockSec: 2 }),
      store,
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "completed",
      reason: "max_wall_clock",
      turnCount: 1,
    });
  });

  it("terminates when a send exceeds the idle timeout", async () => {
    vi.useFakeTimers();
    const drive = startDrive();
    const send = vi.fn(() => new Promise<DriveSendResult>(() => {}));
    const resultPromise = runAgentDrive({
      key,
      goal: drive.goal,
      targetLabel: "Harness",
      send,
      surface: async () => {},
      bounds: createBounds({ idleTimeoutSec: 1 }),
      store,
    });

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(resultPromise).resolves.toMatchObject({
      status: "completed",
      reason: "idle_timeout",
      turnCount: 0,
    });
  });

  it("honors a stop request between turns and clears active state", async () => {
    const drive = startDrive();
    const send = vi.fn(async (): Promise<DriveSendResult> => {
      store.requestStop(drive.id);
      return { kind: "reply", reply: "Stopping after this reply." };
    });

    const result = await runAgentDrive({
      key,
      goal: drive.goal,
      targetLabel: "Harness",
      send,
      surface: async () => {},
      bounds: createBounds(),
      store,
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "completed",
      reason: "stopped",
      turnCount: 1,
    });
    expect(store.getActiveDrive(key)).toBeUndefined();
  });

  it("surfaces send errors and terminates within the configured bounds", async () => {
    const drive = startDrive();
    const surfaced: string[] = [];
    const send = vi.fn(async (): Promise<DriveSendResult> => {
      throw new Error("target unavailable");
    });
    const bounds = createBounds({ maxTurns: 1 });

    const result = await runAgentDrive({
      key,
      goal: drive.goal,
      targetLabel: "Harness",
      send,
      surface: async (text) => {
        surfaced.push(text);
      },
      bounds,
      store,
    });

    expect(bounds.now).toHaveBeenCalled();
    expect(surfaced).toEqual([
      expect.stringContaining("🧭 Agent → Harness:"),
      "⚠️ Agent drive error: target unavailable",
    ]);
    expect(result).toMatchObject({
      status: "completed",
      reason: "error",
      turnCount: 0,
    });
  });

  it("reaps a stale active drive after restart", async () => {
    const drive = startDrive();
    now = 10_000;

    const result = await runAgentDrive({
      key,
      goal: drive.goal,
      targetLabel: "Harness",
      send: vi.fn(),
      surface: vi.fn(),
      bounds: createBounds({ maxWallClockSec: 5 }),
      store,
    });

    expect(result).toMatchObject({
      status: "completed",
      reason: "stale",
      turnCount: 0,
    });
    expect(store.getDrive(drive.id)).toMatchObject({
      status: "stale",
      outcome: "stale",
    });
    expect(store.getActiveDrive(key)).toBeUndefined();
  });
});
