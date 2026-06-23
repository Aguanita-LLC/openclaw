import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDriveStateStore } from "../../acp/agent-drive-state.js";
import type { ResolvedConfiguredAcpBinding } from "../../acp/persistent-bindings.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createAgentDriveTool, type AgentDriveToolDeps } from "./agent-drive-tool.js";

const cfg: OpenClawConfig = {
  acp: {
    drive: {
      maxTurns: 4,
      maxWallClockSec: 120,
      idleTimeoutSec: 10,
      redirectPrefix: "@codex ",
    },
  },
};

function createStore(): AgentDriveStateStore {
  let active:
    | {
        id: string;
        key: { channel: string; accountId: string; thread: string };
        keyId: string;
        goal: string;
        ownerSessionKey: string;
        targetSessionKey: string;
        status: "active" | "stop_requested";
        turnCount: number;
        startedAt: number;
        updatedAt: number;
      }
    | undefined;
  return {
    startDrive: vi.fn<AgentDriveStateStore["startDrive"]>((key, input) => {
      const timestamp = Date.now();
      active = {
        id: "drive-1",
        key,
        keyId: "discord␟default␟thread-1",
        goal: input.goal,
        ownerSessionKey: input.ownerSessionKey,
        targetSessionKey: input.targetSessionKey,
        status: "active",
        turnCount: 0,
        startedAt: timestamp,
        updatedAt: timestamp,
      };
      return { status: "active" as const, record: active };
    }),
    getActiveDrive: vi.fn(() => active),
    getDrive: vi.fn((id) => (active?.id === id ? active : undefined)),
    listDrives: vi.fn(() => (active ? [active] : [])),
    recordTurn: vi.fn((id) => {
      if (!active || active.id !== id) {
        return undefined;
      }
      active = { ...active, turnCount: active.turnCount + 1, updatedAt: active.updatedAt + 1 };
      return active;
    }),
    requestStop: vi.fn((id) => {
      if (!active || active.id !== id) {
        return undefined;
      }
      active = { ...active, status: "stop_requested" };
      return active;
    }),
    completeDrive: vi.fn((id) => {
      if (!active || active.id !== id) {
        return undefined;
      }
      const completed = {
        ...active,
        status: "completed" as const,
        completedAt: active.updatedAt + 1,
        outcome: "done" as const,
      };
      active = undefined;
      return completed;
    }),
    reapStaleDrives: vi.fn(() => []),
  };
}

function createBinding(
  mode: "persistent" | "oneshot" = "persistent",
): ResolvedConfiguredAcpBinding {
  return {
    spec: {
      channel: "discord",
      accountId: "default",
      conversationId: "thread-1",
      agentId: "main",
      acpAgentId: "codex",
      mode,
    },
    record: {
      bindingId: "config:acp:discord:default:thread-1",
      targetSessionKey: "agent:main:acp:binding:discord:default:hash",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "thread-1",
      },
      status: "active",
      boundAt: 0,
    },
  };
}

function createDeps(overrides: Partial<AgentDriveToolDeps> = {}) {
  const store = createStore();
  const deps: AgentDriveToolDeps = {
    store,
    resolveBinding: vi.fn<AgentDriveToolDeps["resolveBinding"]>(() => createBinding()),
    ensureBinding: vi.fn<AgentDriveToolDeps["ensureBinding"]>(async () => ({
      ok: true,
      sessionKey: "agent:main:acp:binding:discord:default:hash",
    })),
    sendSession: vi
      .fn()
      .mockResolvedValueOnce("I found the problem.")
      .mockResolvedValueOnce("The goal is complete."),
    judgeReply: vi
      .fn()
      .mockResolvedValueOnce({ kind: "reply" })
      .mockResolvedValueOnce({ kind: "done" }),
    surface: vi.fn(async () => {}),
    ...overrides,
  };
  return { deps, store };
}

describe("agent_drive tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts a persistent bound drive and runs send plus agent judgment to completion", async () => {
    const { deps, store } = createDeps();
    const tool = createAgentDriveTool({
      agentSessionKey: "agent:main:discord:direct:operator",
      agentChannel: "discord",
      config: cfg,
      deps,
    });

    const result = await tool.execute("call-1", {
      action: "start",
      channel: "discord",
      accountId: "default",
      thread: "thread-1",
      goal: "fix the failing implementation",
    });

    expect(deps.resolveBinding).toHaveBeenCalledWith({
      cfg,
      channel: "discord",
      accountId: "default",
      conversationId: "thread-1",
    });
    expect(deps.ensureBinding).toHaveBeenCalled();
    expect(store.reapStaleDrives).toHaveBeenCalledWith(expect.any(Number), 120_000);
    expect(vi.mocked(store.reapStaleDrives).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(store.startDrive).mock.invocationCallOrder[0],
    );
    expect(store.startDrive).toHaveBeenCalledWith(
      {
        channel: "discord",
        accountId: "default",
        thread: "thread-1",
      },
      {
        goal: "fix the failing implementation",
        ownerSessionKey: "agent:main:discord:direct:operator",
        targetSessionKey: "agent:main:acp:binding:discord:default:hash",
      },
    );
    expect(deps.sendSession).toHaveBeenCalledTimes(2);
    expect(deps.sendSession).toHaveBeenCalledWith(
      expect.objectContaining({
        targetSessionKey: "agent:main:acp:binding:discord:default:hash",
      }),
    );
    expect(deps.judgeReply).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        goal: "fix the failing implementation",
        reply: "The goal is complete.",
      }),
    );
    expect(deps.surface).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        accountId: "default",
        thread: "thread-1",
        text: expect.stringContaining("🧭 Agent → Codex:"),
      }),
    );
    expect(result.details).toMatchObject({
      status: "completed",
      reason: "done",
      finalReply: "The goal is complete.",
      turnCount: 2,
    });
    expect(
      store.getActiveDrive({ channel: "discord", accountId: "default", thread: "thread-1" }),
    ).toBeUndefined();
  });

  it("requests stop for the active target thread", async () => {
    const { deps, store } = createDeps();
    store.startDrive(
      { channel: "discord", accountId: "default", thread: "thread-1" },
      {
        goal: "existing goal",
        ownerSessionKey: "agent:main:discord:direct:operator",
        targetSessionKey: "agent:main:acp:binding:discord:default:hash",
      },
    );
    const tool = createAgentDriveTool({
      agentSessionKey: "agent:main:discord:channel:thread-1",
      agentChannel: "discord",
      config: cfg,
      deps,
    });

    const result = await tool.execute("call-2", {
      action: "stop",
      channel: "discord",
      accountId: "default",
      thread: "thread-1",
    });

    expect(store.requestStop).toHaveBeenCalledWith("drive-1");
    expect(result.details).toMatchObject({
      status: "stop_requested",
      driveId: "drive-1",
    });
  });

  it("rejects missing and one-shot ACP bindings", async () => {
    const missing = createDeps({ resolveBinding: vi.fn(() => null) });
    const missingTool = createAgentDriveTool({
      agentSessionKey: "agent:main:discord:direct:operator",
      config: cfg,
      deps: missing.deps,
    });
    const missingResult = await missingTool.execute("call-3", {
      action: "start",
      channel: "discord",
      thread: "thread-1",
      goal: "goal",
    });
    expect(missingResult.details).toMatchObject({
      status: "error",
      error: "binding_not_found",
    });

    const oneShot = createDeps({
      resolveBinding: vi.fn<AgentDriveToolDeps["resolveBinding"]>(() => createBinding("oneshot")),
    });
    const oneShotTool = createAgentDriveTool({
      agentSessionKey: "agent:main:discord:direct:operator",
      config: cfg,
      deps: oneShot.deps,
    });
    const oneShotResult = await oneShotTool.execute("call-4", {
      action: "start",
      channel: "discord",
      thread: "thread-1",
      goal: "goal",
    });
    expect(oneShotResult.details).toMatchObject({
      status: "error",
      error: "persistent_binding_required",
    });
  });
});
