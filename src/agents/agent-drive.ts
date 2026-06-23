import type {
  AgentDriveKey,
  AgentDriveOutcome,
  AgentDriveRecord,
  AgentDriveStateStore,
} from "../acp/agent-drive-state.js";
import { formatErrorMessage } from "../infra/errors.js";

export type DriveSendResult =
  | {
      kind: "reply";
      reply: string;
    }
  | {
      kind: "done";
      reply: string;
    };

export type AgentDriveBounds = {
  maxTurns: number;
  maxWallClockSec: number;
  idleTimeoutSec: number;
  now?: () => number;
};

export type DriveResult =
  | {
      status: "completed";
      reason: AgentDriveOutcome;
      turnCount: number;
      finalReply?: string;
    }
  | {
      status: "not_active";
      reason: "not_active";
      turnCount: 0;
    };

type DriveBoundsReason = Extract<
  AgentDriveOutcome,
  "max_turns" | "max_wall_clock" | "idle_timeout"
>;

type DriveBoundsCheck =
  | {
      kind: "continue";
    }
  | {
      kind: "terminate";
      reason: DriveBoundsReason;
    };

function toBoundedInteger(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function resolveBounds(params: {
  record: AgentDriveRecord;
  bounds: AgentDriveBounds;
  now: number;
}): DriveBoundsCheck {
  const maxTurns = toBoundedInteger(params.bounds.maxTurns, 0);
  if (params.record.turnCount >= maxTurns) {
    return { kind: "terminate", reason: "max_turns" };
  }

  const maxWallClockMs = toBoundedInteger(params.bounds.maxWallClockSec, 0) * 1_000;
  if (params.now - params.record.startedAt >= maxWallClockMs) {
    return { kind: "terminate", reason: "max_wall_clock" };
  }

  const idleTimeoutMs = toBoundedInteger(params.bounds.idleTimeoutSec, 0) * 1_000;
  if (params.now - params.record.updatedAt >= idleTimeoutMs) {
    return { kind: "terminate", reason: "idle_timeout" };
  }

  return { kind: "continue" };
}

function composeDrivePrompt(params: {
  goal: string;
  turn: number;
  previousReply?: string;
}): string {
  const previousReply = params.previousReply?.trim();
  return [
    `Goal: ${params.goal.trim()}`,
    `Drive turn: ${params.turn}`,
    ...(previousReply ? [`Previous target reply:\n${previousReply}`] : []),
    "Continue working toward the goal. Return the next substantive progress update.",
  ].join("\n\n");
}

async function waitForDriveSend(params: {
  send: () => Promise<DriveSendResult>;
  idleTimeoutMs: number;
}): Promise<
  | {
      kind: "result";
      result: DriveSendResult;
    }
  | {
      kind: "idle_timeout";
    }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ kind: "idle_timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "idle_timeout" }), params.idleTimeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      params.send().then((result) => ({ kind: "result" as const, result })),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function completeDrive(params: {
  store: AgentDriveStateStore;
  record: AgentDriveRecord;
  reason: AgentDriveOutcome;
  finalReply?: string;
}): DriveResult {
  const completed = params.store.completeDrive(params.record.id, params.reason);
  return {
    status: "completed",
    reason: params.reason,
    turnCount: completed?.turnCount ?? params.record.turnCount,
    ...(params.finalReply !== undefined ? { finalReply: params.finalReply } : {}),
  };
}

export async function runAgentDrive(params: {
  key: AgentDriveKey;
  goal: string;
  targetLabel: string;
  send: (prompt: string) => Promise<DriveSendResult>;
  surface: (text: string) => Promise<void>;
  bounds: AgentDriveBounds;
  store: AgentDriveStateStore;
}): Promise<DriveResult> {
  const now = params.bounds.now ?? (() => Date.now());
  const maxWallClockMs = toBoundedInteger(params.bounds.maxWallClockSec, 0) * 1_000;
  const reaped = params.store.reapStaleDrives(now(), maxWallClockMs);
  const stale = reaped.find(
    (record) =>
      record.key.channel === params.key.channel &&
      record.key.accountId === params.key.accountId &&
      record.key.thread === params.key.thread,
  );
  if (stale) {
    return {
      status: "completed",
      reason: "stale",
      turnCount: stale.turnCount,
    };
  }

  let previousReply: string | undefined;
  while (true) {
    const record = params.store.getActiveDrive(params.key);
    if (!record) {
      return {
        status: "not_active",
        reason: "not_active",
        turnCount: 0,
      };
    }
    if (record.status === "stop_requested") {
      return completeDrive({
        store: params.store,
        record,
        reason: "stopped",
        finalReply: previousReply,
      });
    }

    const boundsCheck = resolveBounds({
      record,
      bounds: params.bounds,
      now: now(),
    });
    if (boundsCheck.kind === "terminate") {
      return completeDrive({
        store: params.store,
        record,
        reason: boundsCheck.reason,
        finalReply: previousReply,
      });
    }

    const prompt = composeDrivePrompt({
      goal: params.goal,
      turn: record.turnCount + 1,
      previousReply,
    });
    await params.surface(`🧭 Agent → ${params.targetLabel.trim()}:\n${prompt}`);

    let sendResult: DriveSendResult;
    try {
      const waited = await waitForDriveSend({
        send: () => params.send(prompt),
        idleTimeoutMs: toBoundedInteger(params.bounds.idleTimeoutSec, 0) * 1_000,
      });
      if (waited.kind === "idle_timeout") {
        return completeDrive({
          store: params.store,
          record,
          reason: "idle_timeout",
          finalReply: previousReply,
        });
      }
      sendResult = waited.result;
    } catch (error) {
      await params.surface(`⚠️ Agent drive error: ${formatErrorMessage(error)}`);
      return completeDrive({
        store: params.store,
        record,
        reason: "error",
        finalReply: previousReply,
      });
    }

    const reply = sendResult.reply.trim();
    const afterTurn = params.store.recordTurn(record.id) ?? record;
    previousReply = reply;
    await params.surface(`🧭 ${params.targetLabel.trim()} → Agent:\n${reply}`);

    if (sendResult.kind === "done") {
      return completeDrive({
        store: params.store,
        record: afterTurn,
        reason: "done",
        finalReply: reply,
      });
    }
  }
}
