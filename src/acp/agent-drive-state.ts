import crypto from "node:crypto";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

const AGENT_DRIVE_STATE_VERSION = 1;

export type AgentDriveKey = {
  channel: string;
  accountId: string;
  thread: string;
};

export type AgentDriveOutcome =
  | "done"
  | "stopped"
  | "max_turns"
  | "max_wall_clock"
  | "idle_timeout"
  | "error"
  | "stale";

export type AgentDriveActiveStatus = "active" | "stop_requested";

export type AgentDriveTerminalStatus = "completed" | "stale";

export type AgentDriveStatus = AgentDriveActiveStatus | AgentDriveTerminalStatus;

export type AgentDriveRecord = {
  id: string;
  key: AgentDriveKey;
  keyId: string;
  goal: string;
  ownerSessionKey: string;
  targetSessionKey: string;
  status: AgentDriveStatus;
  turnCount: number;
  startedAt: number;
  updatedAt: number;
  stopRequestedAt?: number;
  completedAt?: number;
  outcome?: AgentDriveOutcome;
};

export type AgentDriveStartInput = {
  goal: string;
  ownerSessionKey: string;
  targetSessionKey: string;
};

export type AgentDriveStartResult =
  | {
      status: "active";
      record: AgentDriveRecord;
    }
  | {
      status: "error";
      error: "already_active";
      existing: AgentDriveRecord;
    };

export type AgentDriveStateStore = {
  startDrive: (key: AgentDriveKey, input: AgentDriveStartInput) => AgentDriveStartResult;
  getActiveDrive: (key: AgentDriveKey) => AgentDriveRecord | undefined;
  getDrive: (id: string) => AgentDriveRecord | undefined;
  listDrives: () => AgentDriveRecord[];
  recordTurn: (id: string) => AgentDriveRecord | undefined;
  requestStop: (id: string) => AgentDriveRecord | undefined;
  completeDrive: (id: string, outcome: AgentDriveOutcome) => AgentDriveRecord | undefined;
  reapStaleDrives: (now: number, ttlMs: number) => AgentDriveRecord[];
};

type PersistedAgentDriveState = {
  version: typeof AGENT_DRIVE_STATE_VERSION;
  drives: AgentDriveRecord[];
};

type AgentDriveStateStoreOptions = {
  filePath?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
};

function normalizeDriveText(value: string): string {
  return value.trim();
}

function normalizeDriveKey(key: AgentDriveKey): AgentDriveKey {
  return {
    channel: normalizeDriveText(key.channel).toLowerCase(),
    accountId: normalizeDriveText(key.accountId).toLowerCase() || "default",
    thread: normalizeDriveText(key.thread),
  };
}

export function buildAgentDriveKeyId(key: AgentDriveKey): string {
  const normalized = normalizeDriveKey(key);
  return [normalized.channel, normalized.accountId, normalized.thread].join("\u241f");
}

function isActiveDriveStatus(status: AgentDriveStatus): status is AgentDriveActiveStatus {
  return status === "active" || status === "stop_requested";
}

function normalizeDriveRecord(raw: unknown): AgentDriveRecord | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const id = normalizeOptionalString(record.id);
  const goal = normalizeOptionalString(record.goal);
  const ownerSessionKey = normalizeOptionalString(record.ownerSessionKey);
  const targetSessionKey = normalizeOptionalString(record.targetSessionKey);
  const status = record.status;
  const key = record.key;
  if (
    !id ||
    !goal ||
    !ownerSessionKey ||
    !targetSessionKey ||
    (status !== "active" &&
      status !== "stop_requested" &&
      status !== "completed" &&
      status !== "stale") ||
    !key ||
    typeof key !== "object"
  ) {
    return null;
  }
  const keyRecord = key as Record<string, unknown>;
  const channel = normalizeOptionalString(keyRecord.channel);
  const accountId = normalizeOptionalString(keyRecord.accountId);
  const thread = normalizeOptionalString(keyRecord.thread);
  if (!channel || !thread) {
    return null;
  }
  const normalizedKey = normalizeDriveKey({
    channel,
    accountId: accountId ?? "default",
    thread,
  });
  const startedAt = typeof record.startedAt === "number" ? record.startedAt : 0;
  const updatedAt = typeof record.updatedAt === "number" ? record.updatedAt : startedAt;
  const turnCount =
    typeof record.turnCount === "number" && Number.isFinite(record.turnCount)
      ? Math.max(0, Math.floor(record.turnCount))
      : 0;
  return {
    id,
    key: normalizedKey,
    keyId: buildAgentDriveKeyId(normalizedKey),
    goal,
    ownerSessionKey,
    targetSessionKey,
    status,
    turnCount,
    startedAt,
    updatedAt,
    ...(typeof record.stopRequestedAt === "number"
      ? { stopRequestedAt: record.stopRequestedAt }
      : {}),
    ...(typeof record.completedAt === "number" ? { completedAt: record.completedAt } : {}),
    ...(typeof record.outcome === "string" ? { outcome: record.outcome as AgentDriveOutcome } : {}),
  };
}

function loadState(filePath: string): PersistedAgentDriveState {
  const parsed = loadJsonFile<PersistedAgentDriveState>(filePath);
  if (!parsed || parsed.version !== AGENT_DRIVE_STATE_VERSION || !Array.isArray(parsed.drives)) {
    return {
      version: AGENT_DRIVE_STATE_VERSION,
      drives: [],
    };
  }
  return {
    version: AGENT_DRIVE_STATE_VERSION,
    drives: parsed.drives
      .map(normalizeDriveRecord)
      .filter((record): record is AgentDriveRecord => Boolean(record)),
  };
}

function saveState(filePath: string, records: AgentDriveRecord[]): void {
  saveJsonFile(filePath, {
    version: AGENT_DRIVE_STATE_VERSION,
    drives: records.toSorted((a, b) => a.id.localeCompare(b.id)),
  });
}

export function resolveAgentDriveStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "acp", "agent-drive-state.json");
}

export function createAgentDriveStateStore(
  options: AgentDriveStateStoreOptions = {},
): AgentDriveStateStore {
  const filePath = options.filePath ?? resolveAgentDriveStatePath(options.env);
  const now = options.now ?? (() => Date.now());

  const loadRecords = () => loadState(filePath).drives;
  const saveRecords = (records: AgentDriveRecord[]) => saveState(filePath, records);
  const updateRecord = (
    id: string,
    mutate: (record: AgentDriveRecord) => AgentDriveRecord,
  ): AgentDriveRecord | undefined => {
    const records = loadRecords();
    const index = records.findIndex((record) => record.id === id);
    if (index < 0) {
      return undefined;
    }
    const nextRecord = mutate(records[index]);
    const nextRecords = [...records];
    nextRecords[index] = nextRecord;
    saveRecords(nextRecords);
    return nextRecord;
  };

  return {
    startDrive(key, input) {
      const normalizedKey = normalizeDriveKey(key);
      const keyId = buildAgentDriveKeyId(normalizedKey);
      const records = loadRecords();
      const existing = records.find(
        (record) => record.keyId === keyId && isActiveDriveStatus(record.status),
      );
      if (existing) {
        return {
          status: "error",
          error: "already_active",
          existing,
        };
      }
      const timestamp = now();
      const record: AgentDriveRecord = {
        id: crypto.randomUUID(),
        key: normalizedKey,
        keyId,
        goal: input.goal.trim(),
        ownerSessionKey: input.ownerSessionKey.trim(),
        targetSessionKey: input.targetSessionKey.trim(),
        status: "active",
        turnCount: 0,
        startedAt: timestamp,
        updatedAt: timestamp,
      };
      saveRecords([...records, record]);
      return {
        status: "active",
        record,
      };
    },
    getActiveDrive(key) {
      const keyId = buildAgentDriveKeyId(key);
      return loadRecords().find(
        (record) => record.keyId === keyId && isActiveDriveStatus(record.status),
      );
    },
    getDrive(id) {
      return loadRecords().find((record) => record.id === id);
    },
    listDrives() {
      return loadRecords();
    },
    recordTurn(id) {
      return updateRecord(id, (record) => ({
        ...record,
        turnCount: record.turnCount + 1,
        updatedAt: now(),
      }));
    },
    requestStop(id) {
      return updateRecord(id, (record) => {
        if (!isActiveDriveStatus(record.status)) {
          return record;
        }
        const timestamp = now();
        return {
          ...record,
          status: "stop_requested",
          stopRequestedAt: timestamp,
          updatedAt: timestamp,
        };
      });
    },
    completeDrive(id, outcome) {
      return updateRecord(id, (record) => {
        const timestamp = now();
        return {
          ...record,
          status: "completed",
          outcome,
          completedAt: timestamp,
          updatedAt: timestamp,
        };
      });
    },
    reapStaleDrives(currentTime, ttlMs) {
      const records = loadRecords();
      const boundedTtlMs = Math.max(0, Math.floor(ttlMs));
      const staleIds = new Set(
        records
          .filter((record) => isActiveDriveStatus(record.status))
          .filter((record) => currentTime - record.updatedAt > boundedTtlMs)
          .map((record) => record.id),
      );
      if (staleIds.size === 0) {
        return [];
      }
      const reaped: AgentDriveRecord[] = [];
      const nextRecords: AgentDriveRecord[] = [];
      for (const record of records) {
        if (!staleIds.has(record.id)) {
          nextRecords.push(record);
          continue;
        }
        const nextRecord: AgentDriveRecord = {
          ...record,
          status: "stale",
          outcome: "stale",
          completedAt: currentTime,
          updatedAt: currentTime,
        };
        reaped.push(nextRecord);
        nextRecords.push(nextRecord);
      }
      saveRecords(nextRecords);
      return reaped;
    },
  };
}

let defaultAgentDriveStateStore: AgentDriveStateStore | undefined;

export function getAgentDriveStateStore(): AgentDriveStateStore {
  defaultAgentDriveStateStore ??= createAgentDriveStateStore();
  return defaultAgentDriveStateStore;
}

export const __testing = {
  resetDefaultAgentDriveStateStoreForTests() {
    defaultAgentDriveStateStore = undefined;
  },
};
