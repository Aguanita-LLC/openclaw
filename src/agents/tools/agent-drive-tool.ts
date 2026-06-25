import { Type } from "typebox";
import { getAgentDriveStateStore, type AgentDriveStateStore } from "../../acp/agent-drive-state.js";
import { ensureConfiguredAcpBindingSession } from "../../acp/persistent-bindings.lifecycle.js";
import { resolveConfiguredAcpBindingRecord } from "../../acp/persistent-bindings.resolve.js";
import type {
  ConfiguredAcpBindingSpec,
  ResolvedConfiguredAcpBinding,
} from "../../acp/persistent-bindings.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { runAgentDrive, type AgentDriveBounds, type DriveSendResult } from "../agent-drive.js";
import { readLatestAssistantReplySnapshot, type AssistantReplySnapshot } from "../run-wait.js";
import { stringEnum } from "../schema/typebox.js";
import { runAgentStep } from "./agent-step.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import { createMessageTool } from "./message-tool.js";
import { createSessionsSendTool } from "./sessions-send-tool.js";

const DEFAULT_AGENT_DRIVE_MAX_TURNS = 8;
const DEFAULT_AGENT_DRIVE_MAX_WALL_CLOCK_SEC = 1_800;
const DEFAULT_AGENT_DRIVE_IDLE_TIMEOUT_SEC = 120;
const AGENT_DRIVE_TRANSCRIPT_POLL_INTERVAL_MS = 25;
const AGENT_DRIVE_TRANSCRIPT_SETTLE_TIMEOUT_MS = 5_000;
const AGENT_DRIVE_ACTIONS = ["start", "stop"] as const;

const AgentDriveToolSchema = Type.Object({
  action: stringEnum(AGENT_DRIVE_ACTIONS),
  channel: Type.String({ minLength: 1 }),
  accountId: Type.Optional(Type.String()),
  thread: Type.String({ minLength: 1 }),
  goal: Type.Optional(Type.String()),
});

export type AgentDriveJudgment = {
  kind: "reply" | "done";
};

export type AgentDriveToolDeps = {
  store: AgentDriveStateStore;
  resolveBinding: (params: {
    cfg: OpenClawConfig;
    channel: string;
    accountId: string;
    conversationId: string;
  }) => ResolvedConfiguredAcpBinding | null;
  ensureBinding: (params: {
    cfg: OpenClawConfig;
    spec: ConfiguredAcpBindingSpec;
  }) => Promise<
    { ok: true; sessionKey: string } | { ok: false; sessionKey: string; error: string }
  >;
  sendSession: (params: {
    targetSessionKey: string;
    prompt: string;
    timeoutSeconds: number;
  }) => Promise<string>;
  judgeReply: (params: {
    driveId: string;
    goal: string;
    reply: string;
    ownerSessionKey: string;
    timeoutMs: number;
  }) => Promise<AgentDriveJudgment>;
  surface: (params: {
    channel: string;
    accountId: string;
    thread: string;
    text: string;
  }) => Promise<void>;
};

type SessionsSendDetails =
  | {
      status?: unknown;
      reply?: unknown;
      error?: unknown;
    }
  | undefined;

type ResolveSessionsSendReplyDeps = {
  readReplySnapshot: typeof readLatestAssistantReplySnapshot;
  now: () => number;
  sleep: (delayMs: number) => Promise<void>;
};

const defaultResolveSessionsSendReplyDeps: ResolveSessionsSendReplyDeps = {
  readReplySnapshot: readLatestAssistantReplySnapshot,
  now: () => Date.now(),
  sleep: async (delayMs) => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    });
  },
};

async function resolveSessionsSendReply(
  params: {
    details: SessionsSendDetails;
    baseline: AssistantReplySnapshot;
    targetSessionKey: string;
    timeoutMs: number;
  },
  deps: ResolveSessionsSendReplyDeps = defaultResolveSessionsSendReplyDeps,
): Promise<string> {
  if (params.details?.status !== "ok") {
    const status = typeof params.details?.status === "string" ? params.details.status : "unknown";
    const error =
      typeof params.details?.error === "string" && params.details.error.trim()
        ? params.details.error
        : `sessions_send returned status ${status}`;
    throw new Error(error);
  }
  if (typeof params.details.reply === "string") {
    return params.details.reply;
  }

  const timeoutMs = Math.max(0, Math.floor(params.timeoutMs));
  const deadline = deps.now() + timeoutMs;
  while (true) {
    const latest = await deps.readReplySnapshot({
      sessionKey: params.targetSessionKey,
    });
    if (
      latest.text &&
      (!params.baseline.fingerprint || latest.fingerprint !== params.baseline.fingerprint)
    ) {
      return latest.text;
    }
    const remainingMs = deadline - deps.now();
    if (remainingMs <= 0) {
      break;
    }
    await deps.sleep(Math.min(AGENT_DRIVE_TRANSCRIPT_POLL_INTERVAL_MS, remainingMs));
  }

  throw new Error("sessions_send returned status ok without an updated assistant reply");
}

function readDriveConfig(cfg: OpenClawConfig): {
  maxTurns?: number;
  maxWallClockSec?: number;
  idleTimeoutSec?: number;
} {
  const drive = (cfg.acp as { drive?: unknown } | undefined)?.drive;
  return drive && typeof drive === "object"
    ? (drive as {
        maxTurns?: number;
        maxWallClockSec?: number;
        idleTimeoutSec?: number;
      })
    : {};
}

function resolvePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function resolveAgentDriveBounds(cfg: OpenClawConfig): AgentDriveBounds {
  const drive = readDriveConfig(cfg);
  return {
    maxTurns: resolvePositiveInteger(drive.maxTurns, DEFAULT_AGENT_DRIVE_MAX_TURNS),
    maxWallClockSec: resolvePositiveInteger(
      drive.maxWallClockSec,
      DEFAULT_AGENT_DRIVE_MAX_WALL_CLOCK_SEC,
    ),
    idleTimeoutSec: resolvePositiveInteger(
      drive.idleTimeoutSec,
      DEFAULT_AGENT_DRIVE_IDLE_TIMEOUT_SEC,
    ),
  };
}

function parseAgentDriveJudgment(text: string | undefined): AgentDriveJudgment {
  const normalized = normalizeOptionalString(text);
  if (!normalized) {
    return { kind: "reply" };
  }
  const jsonText = normalized.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim() ?? normalized;
  try {
    const parsed: unknown = JSON.parse(jsonText);
    if (parsed && typeof parsed === "object" && (parsed as { kind?: unknown }).kind === "done") {
      return { kind: "done" };
    }
  } catch {
    return { kind: "reply" };
  }
  return { kind: "reply" };
}

async function judgeDriveReply(params: {
  driveId: string;
  goal: string;
  reply: string;
  ownerSessionKey: string;
  timeoutMs: number;
}): Promise<AgentDriveJudgment> {
  const agentId = resolveAgentIdFromSessionKey(params.ownerSessionKey);
  const result = await runAgentStep({
    sessionKey: `agent:${agentId}:agent-drive-judge:${params.driveId}`,
    message: [
      `Goal:\n${params.goal}`,
      `Latest target reply:\n${params.reply}`,
      'Return exactly {"kind":"done"} when the goal is fully complete; otherwise return exactly {"kind":"reply"}.',
    ].join("\n\n"),
    extraSystemPrompt:
      "You are the OpenClaw agent judging whether an external coding session has completed the operator goal. Return JSON only and do not call tools.",
    timeoutMs: params.timeoutMs,
    sourceSessionKey: params.ownerSessionKey,
    sourceTool: "agent_drive",
  });
  return parseAgentDriveJudgment(result);
}

function createDefaultDeps(params: {
  cfg: OpenClawConfig;
  agentSessionKey: string;
  agentChannel?: GatewayMessageChannel;
}): AgentDriveToolDeps {
  const sessionsSendConfig: OpenClawConfig = {
    ...params.cfg,
    tools: {
      ...params.cfg.tools,
      sessions: {
        ...params.cfg.tools?.sessions,
        visibility: "all",
      },
    },
  };
  const sessionsSend = createSessionsSendTool({
    agentSessionKey: params.agentSessionKey,
    agentChannel: params.agentChannel,
    config: sessionsSendConfig,
  });
  const message = createMessageTool({
    agentSessionKey: params.agentSessionKey,
    agentAccountId: undefined,
    currentChannelProvider: params.agentChannel,
    config: params.cfg,
  });

  return {
    store: getAgentDriveStateStore(),
    resolveBinding: resolveConfiguredAcpBindingRecord,
    ensureBinding: ensureConfiguredAcpBindingSession,
    async sendSession(sendParams) {
      const baseline = await readLatestAssistantReplySnapshot({
        sessionKey: sendParams.targetSessionKey,
      });
      const result = await sessionsSend.execute("agent-drive-send", {
        sessionKey: sendParams.targetSessionKey,
        message: sendParams.prompt,
        timeoutSeconds: sendParams.timeoutSeconds,
      });
      return await resolveSessionsSendReply({
        details: result.details as SessionsSendDetails,
        baseline,
        targetSessionKey: sendParams.targetSessionKey,
        timeoutMs: Math.min(
          sendParams.timeoutSeconds * 1_000,
          AGENT_DRIVE_TRANSCRIPT_SETTLE_TIMEOUT_MS,
        ),
      });
    },
    judgeReply: judgeDriveReply,
    async surface(surfaceParams) {
      const result = await message.execute("agent-drive-surface", {
        action: "send",
        channel: surfaceParams.channel,
        accountId: surfaceParams.accountId,
        target: surfaceParams.thread,
        message: surfaceParams.text,
      });
      const details = result.details as { status?: unknown; error?: unknown } | undefined;
      if (
        details?.status === "error" ||
        details?.status === "forbidden" ||
        details?.status === "timeout"
      ) {
        throw new Error(
          typeof details.error === "string" ? details.error : "Failed to surface agent drive text",
        );
      }
    },
  };
}

export function createAgentDriveTool(options: {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  config?: OpenClawConfig;
  deps?: AgentDriveToolDeps;
}): AnyAgentTool {
  return {
    label: "Agent Drive",
    name: "agent_drive",
    displaySummary: "Start or stop an agent-driven persistent ACP session.",
    description:
      "Start or stop agent-driven work in an existing persistent ACP-bound thread. Start requires a goal plus target channel/account/thread. Stop requests cancellation for the active drive on that thread.",
    parameters: AgentDriveToolSchema,
    ownerOnly: true,
    execute: async (_toolCallId, args) => {
      const input = args as Record<string, unknown>;
      const action = readStringParam(input, "action", { required: true });
      const channel = readStringParam(input, "channel", { required: true }).toLowerCase();
      const accountId = readStringParam(input, "accountId")?.toLowerCase() || "default";
      const thread = readStringParam(input, "thread", { required: true });
      const key = { channel, accountId, thread };
      const cfg = options.config ?? {};
      const agentSessionKey = normalizeOptionalString(options.agentSessionKey);
      if (!agentSessionKey) {
        return jsonResult({
          status: "error",
          error: "owner_session_required",
          message: "agent_drive requires an active owner agent session.",
        });
      }
      const deps =
        options.deps ??
        createDefaultDeps({
          cfg,
          agentSessionKey,
          agentChannel: options.agentChannel,
        });

      if (action === "stop") {
        const active = deps.store.getActiveDrive(key);
        if (!active) {
          return jsonResult({
            status: "not_active",
            message: "No active agent drive exists for that thread.",
          });
        }
        deps.store.requestStop(active.id);
        return jsonResult({
          status: "stop_requested",
          driveId: active.id,
        });
      }

      const goal = readStringParam(input, "goal", { required: true });
      const binding = deps.resolveBinding({
        cfg,
        channel,
        accountId,
        conversationId: thread,
      });
      if (!binding) {
        return jsonResult({
          status: "error",
          error: "binding_not_found",
          message: "No configured persistent ACP binding exists for that thread.",
        });
      }
      if (binding.spec.mode !== "persistent") {
        return jsonResult({
          status: "error",
          error: "persistent_binding_required",
          message: "Agent drive requires a persistent ACP binding.",
        });
      }
      const ensured = await deps.ensureBinding({
        cfg,
        spec: binding.spec,
      });
      if (!ensured.ok) {
        return jsonResult({
          status: "error",
          error: "binding_unavailable",
          message: `Persistent ACP binding unavailable: ${ensured.error}`,
        });
      }
      const bounds = resolveAgentDriveBounds(cfg);
      deps.store.reapStaleDrives(Date.now(), bounds.maxWallClockSec * 1_000);
      const started = deps.store.startDrive(key, {
        goal,
        ownerSessionKey: agentSessionKey,
        targetSessionKey: ensured.sessionKey,
      });
      if (started.status === "error") {
        return jsonResult({
          status: "error",
          error: "already_active",
          driveId: started.existing.id,
        });
      }

      try {
        const targetLabel =
          normalizeOptionalString(binding.spec.label) ??
          normalizeOptionalString(binding.spec.acpAgentId) ??
          binding.spec.agentId;
        const result = await runAgentDrive({
          key,
          goal,
          targetLabel,
          bounds,
          store: deps.store,
          send: async (prompt): Promise<DriveSendResult> => {
            const reply = await deps.sendSession({
              targetSessionKey: ensured.sessionKey,
              prompt,
              timeoutSeconds: bounds.idleTimeoutSec,
            });
            const judgment = await deps.judgeReply({
              driveId: started.record.id,
              goal,
              reply,
              ownerSessionKey: agentSessionKey,
              timeoutMs: bounds.idleTimeoutSec * 1_000,
            });
            return {
              kind: judgment.kind,
              reply,
            };
          },
          surface: async (text) => {
            await deps.surface({
              channel,
              accountId,
              thread,
              text,
            });
          },
        });
        return jsonResult(result);
      } catch (error) {
        deps.store.completeDrive(started.record.id, "error");
        return jsonResult({
          status: "error",
          error: "drive_failed",
          message: formatErrorMessage(error),
        });
      }
    },
  };
}

export const __testing = {
  parseAgentDriveJudgment,
  resolveSessionsSendReply,
  resolveAgentDriveBounds,
};
