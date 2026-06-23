import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentDriveStateStore, type AgentDriveKey } from "./agent-drive-state.js";

describe("agent drive state store", () => {
  let tmpDir: string;
  let storePath: string;
  let now = 1_000;

  const key: AgentDriveKey = {
    channel: "discord",
    accountId: "default",
    thread: "thread-1",
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-drive-state-"));
    storePath = path.join(tmpDir, "agent-drive-state.json");
    now = 1_000;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists a single active drive per thread key and survives reload", () => {
    const store = createAgentDriveStateStore({
      filePath: storePath,
      now: () => now,
    });

    const started = store.startDrive(key, {
      goal: "fix the failing test",
      ownerSessionKey: "agent:main:discord:channel:1",
      targetSessionKey: "agent:harness:acp:session",
    });

    expect(started.status).toBe("active");
    if (started.status !== "active") {
      throw new Error("expected active drive");
    }
    expect(started.record.goal).toBe("fix the failing test");

    expect(
      store.startDrive(key, {
        goal: "second goal",
        ownerSessionKey: "agent:main:discord:channel:1",
        targetSessionKey: "agent:harness:acp:session",
      }),
    ).toEqual({ status: "error", error: "already_active", existing: started.record });

    const reloaded = createAgentDriveStateStore({
      filePath: storePath,
      now: () => now,
    });
    expect(reloaded.getActiveDrive(key)).toEqual(started.record);
  });

  it("records turns, stop requests, completion, and stale-drive reaping", () => {
    const store = createAgentDriveStateStore({
      filePath: storePath,
      now: () => now,
    });
    const started = store.startDrive(key, {
      goal: "ship it",
      ownerSessionKey: "agent:main:discord:channel:1",
      targetSessionKey: "agent:harness:acp:session",
    });
    if (started.status !== "active") {
      throw new Error("expected active drive");
    }

    now = 2_000;
    const afterTurn = store.recordTurn(started.record.id);
    expect(afterTurn?.turnCount).toBe(1);
    expect(afterTurn?.updatedAt).toBe(2_000);

    now = 3_000;
    const stopRequested = store.requestStop(started.record.id);
    expect(stopRequested?.status).toBe("stop_requested");
    expect(stopRequested?.stopRequestedAt).toBe(3_000);

    now = 4_000;
    const completed = store.completeDrive(started.record.id, "stopped");
    expect(completed?.status).toBe("completed");
    expect(completed?.outcome).toBe("stopped");
    expect(store.getActiveDrive(key)).toBeUndefined();

    const stale = store.startDrive(key, {
      goal: "old goal",
      ownerSessionKey: "agent:main:discord:channel:1",
      targetSessionKey: "agent:harness:acp:session",
    });
    if (stale.status !== "active") {
      throw new Error("expected active drive");
    }

    now = 10_000;
    const reaped = store.reapStaleDrives(now, 1_000);
    expect(reaped.map((record) => record.id)).toEqual([stale.record.id]);
    expect(store.getActiveDrive(key)).toBeUndefined();
  });
});
