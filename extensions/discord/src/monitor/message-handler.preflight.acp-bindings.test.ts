import * as conversationBindingRuntime from "openclaw/plugin-sdk/conversation-binding-runtime";
import type { AgentDriveStateStore } from "openclaw/plugin-sdk/conversation-binding-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ensureConfiguredBindingRouteReadyMock = vi.hoisted(() => vi.fn());
const getActiveDriveMock = vi.hoisted(() => vi.fn());
const getAgentDriveStateStoreMock = vi.hoisted(() =>
  vi.fn(
    (): AgentDriveStateStore => ({
      startDrive: vi.fn() as AgentDriveStateStore["startDrive"],
      getActiveDrive: getActiveDriveMock as AgentDriveStateStore["getActiveDrive"],
      getDrive: vi.fn() as AgentDriveStateStore["getDrive"],
      listDrives: vi.fn() as AgentDriveStateStore["listDrives"],
      recordTurn: vi.fn() as AgentDriveStateStore["recordTurn"],
      requestStop: vi.fn() as AgentDriveStateStore["requestStop"],
      completeDrive: vi.fn() as AgentDriveStateStore["completeDrive"],
      reapStaleDrives: vi.fn() as AgentDriveStateStore["reapStaleDrives"],
    }),
  ),
);
const resolveConfiguredBindingRouteMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/conversation-binding-runtime")
  >("openclaw/plugin-sdk/conversation-binding-runtime");
  return {
    ...actual,
    ensureConfiguredBindingRouteReady: (
      ...args: Parameters<typeof actual.ensureConfiguredBindingRouteReady>
    ) => ensureConfiguredBindingRouteReadyMock(...args),
    getAgentDriveStateStore: getAgentDriveStateStoreMock,
    resolveConfiguredBindingRoute: (
      ...args: Parameters<typeof actual.resolveConfiguredBindingRoute>
    ) => resolveConfiguredBindingRouteMock(...args),
  } satisfies typeof actual & {
    getAgentDriveStateStore: typeof getAgentDriveStateStoreMock;
  };
});

function createConfiguredDiscordRouteForParams(params: {
  route: ReturnType<typeof createConfiguredDiscordRoute>["route"];
  driveRouting?: { target: "binding-owner-agent" | "bound-session" };
}) {
  const configured = createConfiguredDiscordRoute();
  if (params.driveRouting?.target !== "binding-owner-agent") {
    return configured;
  }
  return {
    ...configured,
    boundSessionKey: undefined,
    boundAgentId: undefined,
    route: params.route,
  };
}

function createDriveEnabledConfig() {
  return {
    ...DEFAULT_PREFLIGHT_CFG,
    acp: {
      ...DEFAULT_PREFLIGHT_CFG.acp,
      drive: {
        redirectPrefix: "@target ",
      },
    },
  } satisfies typeof DEFAULT_PREFLIGHT_CFG & {
    acp: NonNullable<typeof DEFAULT_PREFLIGHT_CFG.acp> & {
      drive: {
        redirectPrefix: string;
      };
    };
  };
}

import { __testing as sessionBindingTesting } from "openclaw/plugin-sdk/conversation-runtime";
import { preflightDiscordMessage } from "./message-handler.preflight.js";
import {
  createDiscordMessage,
  createDiscordPreflightArgs,
  createGuildEvent,
  createGuildTextClient,
  DEFAULT_PREFLIGHT_CFG,
} from "./message-handler.preflight.test-helpers.js";

const GUILD_ID = "guild-1";
const CHANNEL_ID = "channel-1";

function createConfiguredDiscordBinding() {
  return {
    spec: {
      channel: "discord",
      accountId: "default",
      conversationId: CHANNEL_ID,
      agentId: "codex",
      mode: "persistent",
    },
    record: {
      bindingId: "config:acp:discord:default:channel-1",
      targetSessionKey: "agent:codex:acp:binding:discord:default:abc123",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: CHANNEL_ID,
      },
      status: "active",
      boundAt: 0,
      metadata: {
        source: "config",
        mode: "persistent",
        agentId: "codex",
      },
    },
  } as const;
}

function createConfiguredDiscordRoute() {
  const configuredBinding = createConfiguredDiscordBinding();
  return {
    bindingResolution: {
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: CHANNEL_ID,
      },
      compiledBinding: {
        channel: "discord",
        accountPattern: "default",
        binding: {
          type: "acp",
          agentId: "codex",
          match: {
            channel: "discord",
            accountId: "default",
            peer: {
              kind: "channel",
              id: CHANNEL_ID,
            },
          },
        },
        bindingConversationId: CHANNEL_ID,
        target: {
          conversationId: CHANNEL_ID,
        },
        agentId: "codex",
        provider: {
          compileConfiguredBinding: () => ({ conversationId: CHANNEL_ID }),
          matchInboundConversation: () => ({ conversationId: CHANNEL_ID }),
        },
        targetFactory: {
          driverId: "acp",
          materialize: () => ({
            record: configuredBinding.record,
            statefulTarget: {
              kind: "stateful",
              driverId: "acp",
              sessionKey: configuredBinding.record.targetSessionKey,
              agentId: configuredBinding.spec.agentId,
            },
          }),
        },
      },
      match: {
        conversationId: CHANNEL_ID,
      },
      record: configuredBinding.record,
      statefulTarget: {
        kind: "stateful",
        driverId: "acp",
        sessionKey: configuredBinding.record.targetSessionKey,
        agentId: configuredBinding.spec.agentId,
      },
    },
    configuredBinding,
    boundSessionKey: configuredBinding.record.targetSessionKey,
    route: {
      agentId: "codex",
      accountId: "default",
      channel: "discord",
      sessionKey: configuredBinding.record.targetSessionKey,
      mainSessionKey: "agent:codex:main",
      matchedBy: "binding.channel",
      lastRoutePolicy: "bound",
    },
  } as const;
}

function createBasePreflightParams(overrides?: Record<string, unknown>) {
  const message = createDiscordMessage({
    id: "m-1",
    channelId: CHANNEL_ID,
    content: "<@bot-1> hello",
    mentionedUsers: [{ id: "bot-1" }],
    author: {
      id: "user-1",
      bot: false,
      username: "alice",
    },
  });

  return {
    ...createDiscordPreflightArgs({
      cfg: DEFAULT_PREFLIGHT_CFG,
      discordConfig: {
        allowBots: true,
      } as NonNullable<
        import("openclaw/plugin-sdk/config-types").OpenClawConfig["channels"]
      >["discord"],
      data: createGuildEvent({
        channelId: CHANNEL_ID,
        guildId: GUILD_ID,
        author: message.author,
        message,
      }),
      client: createGuildTextClient(CHANNEL_ID),
      botUserId: "bot-1",
    }),
    discordConfig: {
      allowBots: true,
    } as NonNullable<
      import("openclaw/plugin-sdk/config-types").OpenClawConfig["channels"]
    >["discord"],
    ...overrides,
  } satisfies Parameters<typeof preflightDiscordMessage>[0];
}

function createAllowedGuildEntries(requireMention = false) {
  return {
    [GUILD_ID]: {
      id: GUILD_ID,
      channels: {
        [CHANNEL_ID]: {
          enabled: true,
          requireMention,
        },
      },
    },
  };
}

function createHydratedGuildClient(restPayload: Record<string, unknown>) {
  const restGet = vi.fn(async () => restPayload);
  const client = Object.assign(createGuildTextClient(CHANNEL_ID), {
    rest: {
      get: restGet,
    },
  }) as unknown as Parameters<typeof preflightDiscordMessage>[0]["client"];
  return { client, restGet };
}

async function runRestHydrationPreflight(params: {
  messageId: string;
  restPayload: Record<string, unknown>;
}) {
  const message = createDiscordMessage({
    id: params.messageId,
    channelId: CHANNEL_ID,
    content: "",
    author: {
      id: "user-1",
      bot: false,
      username: "alice",
    },
  });
  const { client, restGet } = createHydratedGuildClient(params.restPayload);
  const result = await preflightDiscordMessage(
    createBasePreflightParams({
      client,
      data: createGuildEvent({
        channelId: CHANNEL_ID,
        guildId: GUILD_ID,
        author: message.author,
        message,
      }),
      guildEntries: createAllowedGuildEntries(false),
    }),
  );
  return { result, restGet };
}

describe("preflightDiscordMessage configured ACP bindings", () => {
  beforeEach(() => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    ensureConfiguredBindingRouteReadyMock.mockReset();
    getActiveDriveMock.mockReset();
    getActiveDriveMock.mockReturnValue(undefined);
    getAgentDriveStateStoreMock.mockClear();
    resolveConfiguredBindingRouteMock.mockReset();
    resolveConfiguredBindingRouteMock.mockImplementation((params) =>
      createConfiguredDiscordRouteForParams(params),
    );
    ensureConfiguredBindingRouteReadyMock.mockResolvedValue({ ok: true });
    vi.spyOn(conversationBindingRuntime, "resolveConfiguredBindingRoute").mockImplementation(
      resolveConfiguredBindingRouteMock,
    );
    vi.spyOn(conversationBindingRuntime, "ensureConfiguredBindingRouteReady").mockImplementation(
      ensureConfiguredBindingRouteReadyMock,
    );
  });

  it("does not initialize configured ACP bindings for rejected messages", async () => {
    const result = await preflightDiscordMessage(
      createBasePreflightParams({
        guildEntries: {
          [GUILD_ID]: {
            id: GUILD_ID,
            channels: {
              [CHANNEL_ID]: {
                enabled: false,
              },
            },
          },
        },
      }),
    );

    expect(result).toBeNull();
    expect(resolveConfiguredBindingRouteMock).toHaveBeenCalledTimes(1);
    expect(ensureConfiguredBindingRouteReadyMock).not.toHaveBeenCalled();
  });

  it("initializes configured ACP bindings only after preflight accepts the message", async () => {
    const result = await preflightDiscordMessage(
      createBasePreflightParams({
        guildEntries: {
          [GUILD_ID]: {
            id: GUILD_ID,
            channels: {
              [CHANNEL_ID]: {
                enabled: true,
                requireMention: false,
              },
            },
          },
        },
      }),
    );

    expect(result).not.toBeNull();
    expect(resolveConfiguredBindingRouteMock).toHaveBeenCalledTimes(1);
    expect(ensureConfiguredBindingRouteReadyMock).toHaveBeenCalledTimes(1);
    expect(result?.boundSessionKey).toBe("agent:codex:acp:binding:discord:default:abc123");
  });

  it("accepts plain messages in configured ACP-bound channels without a mention", async () => {
    const message = createDiscordMessage({
      id: "m-no-mention",
      channelId: CHANNEL_ID,
      content: "hello",
      mentionedUsers: [],
      author: {
        id: "user-1",
        bot: false,
        username: "alice",
      },
    });

    const result = await preflightDiscordMessage(
      createBasePreflightParams({
        data: createGuildEvent({
          channelId: CHANNEL_ID,
          guildId: GUILD_ID,
          author: message.author,
          message,
        }),
        guildEntries: createAllowedGuildEntries(false),
      }),
    );

    expect(result).not.toBeNull();
    expect(ensureConfiguredBindingRouteReadyMock).toHaveBeenCalledTimes(1);
    expect(result?.boundSessionKey).toBe("agent:codex:acp:binding:discord:default:abc123");
  });

  it("routes active-drive plain messages to the binding owner agent", async () => {
    getActiveDriveMock.mockReturnValue({
      id: "drive-1",
      status: "active",
    });
    const message = createDiscordMessage({
      id: "m-drive-plain",
      channelId: CHANNEL_ID,
      content: "change course",
      mentionedUsers: [],
      author: {
        id: "user-1",
        bot: false,
        username: "alice",
      },
    });

    const result = await preflightDiscordMessage(
      createBasePreflightParams({
        cfg: createDriveEnabledConfig(),
        data: createGuildEvent({
          channelId: CHANNEL_ID,
          guildId: GUILD_ID,
          author: message.author,
          message,
        }),
        guildEntries: createAllowedGuildEntries(false),
      }),
    );

    expect(result).not.toBeNull();
    expect(getActiveDriveMock).toHaveBeenCalledWith({
      channel: "discord",
      accountId: "default",
      thread: CHANNEL_ID,
    });
    expect(result?.boundSessionKey).toBeUndefined();
    expect(result?.route.sessionKey).toBe("agent:main:discord:channel:channel-1");
    expect(result?.messageText).toBe("change course");
  });

  it("routes active-drive prefixed messages to the bound session with the prefix stripped", async () => {
    getActiveDriveMock.mockReturnValue({
      id: "drive-1",
      status: "active",
    });
    const message = createDiscordMessage({
      id: "m-drive-prefixed",
      channelId: CHANNEL_ID,
      content: "@target inspect this failure",
      mentionedUsers: [],
      author: {
        id: "user-1",
        bot: false,
        username: "alice",
      },
    });

    const result = await preflightDiscordMessage(
      createBasePreflightParams({
        cfg: createDriveEnabledConfig(),
        data: createGuildEvent({
          channelId: CHANNEL_ID,
          guildId: GUILD_ID,
          author: message.author,
          message,
        }),
        guildEntries: createAllowedGuildEntries(false),
      }),
    );

    expect(result).not.toBeNull();
    expect(result?.boundSessionKey).toBe("agent:codex:acp:binding:discord:default:abc123");
    expect(result?.route.sessionKey).toBe("agent:codex:acp:binding:discord:default:abc123");
    expect(result?.messageText).toBe("inspect this failure");
    expect(result?.baseText).toBe("inspect this failure");
  });

  it("hydrates empty guild message payloads from REST before ensuring configured ACP bindings", async () => {
    const { result, restGet } = await runRestHydrationPreflight({
      messageId: "m-rest",
      restPayload: {
        id: "m-rest",
        content: "hello from rest",
        attachments: [],
        embeds: [],
        mentions: [],
        mention_roles: [],
        mention_everyone: false,
        author: {
          id: "user-1",
          username: "alice",
        },
      },
    });

    expect(restGet).toHaveBeenCalledTimes(1);
    expect(result?.messageText).toBe("hello from rest");
    expect(result?.data.message.content).toBe("hello from rest");
    expect(ensureConfiguredBindingRouteReadyMock).toHaveBeenCalledTimes(1);
  });

  it("hydrates sticker-only guild message payloads from REST before ensuring configured ACP bindings", async () => {
    const { result, restGet } = await runRestHydrationPreflight({
      messageId: "m-rest-sticker",
      restPayload: {
        id: "m-rest-sticker",
        content: "",
        attachments: [],
        embeds: [],
        mentions: [],
        mention_roles: [],
        mention_everyone: false,
        sticker_items: [
          {
            id: "sticker-1",
            name: "wave",
          },
        ],
        author: {
          id: "user-1",
          username: "alice",
        },
      },
    });

    expect(restGet).toHaveBeenCalledTimes(1);
    expect(result?.messageText).toBe("<media:sticker> (1 sticker)");
    expect(ensureConfiguredBindingRouteReadyMock).toHaveBeenCalledTimes(1);
  });
});
