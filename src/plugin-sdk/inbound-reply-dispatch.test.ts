import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.types.js";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import type { RecordInboundSession } from "../channels/session.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const deliverDurableInboundReplyPayload = vi.hoisted(() => vi.fn());

vi.mock("../channels/turn/kernel.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../channels/turn/kernel.js")>();
  return {
    ...actual,
    deliverDurableInboundReplyPayload,
  };
});

import {
  dispatchInboundReplyWithBase,
  hasFinalInboundReplyDispatch,
  hasVisibleInboundReplyDispatch,
  recordInboundSessionAndDispatchReply,
  resolveInboundReplyDispatchCounts,
} from "./inbound-reply-dispatch.js";

describe("recordInboundSessionAndDispatchReply", () => {
  beforeEach(() => {
    deliverDurableInboundReplyPayload.mockReset();
  });

  it("delegates record and dispatch through the channel turn kernel once", async () => {
    const recordInboundSession = vi.fn(async () => undefined) as unknown as RecordInboundSession;
    const deliver = vi.fn(async () => undefined);
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async (params) => {
      await params.dispatcherOptions.deliver(
        {
          text: "hello",
          mediaUrls: ["https://example.com/a.png"],
        },
        { kind: "final" },
      );
      return {
        queuedFinal: true,
        counts: { tool: 0, block: 0, final: 1 },
      };
    }) as DispatchReplyWithBufferedBlockDispatcher;
    const ctxPayload = {
      Body: "body",
      RawBody: "body",
      CommandBody: "body",
      From: "sender",
      To: "target",
      SessionKey: "agent:main:test:peer",
      Provider: "test",
      Surface: "test",
    } as FinalizedMsgContext;

    await recordInboundSessionAndDispatchReply({
      cfg: {} as OpenClawConfig,
      channel: "test",
      accountId: "default",
      agentId: "main",
      routeSessionKey: "agent:main:test:peer",
      storePath: "/tmp/sessions.json",
      ctxPayload,
      recordInboundSession,
      dispatchReplyWithBufferedBlockDispatcher,
      deliver,
      onRecordError: vi.fn(),
      onDispatchError: vi.fn(),
    });

    expect(recordInboundSession).toHaveBeenCalledTimes(1);
    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:test:peer",
        ctx: ctxPayload,
      }),
    );
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith({
      text: "hello",
      mediaUrls: ["https://example.com/a.png"],
      mediaUrl: undefined,
      sensitiveMedia: undefined,
      replyToId: undefined,
    });
  });

  it("keeps public compatibility delivery channel-owned when durable is omitted", async () => {
    const recordInboundSession = vi.fn(async () => undefined) as unknown as RecordInboundSession;
    const deliver = vi.fn(async () => undefined);
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async (params) => {
      await params.dispatcherOptions.deliver({ text: "hello" }, { kind: "final" });
      return {
        queuedFinal: true,
        counts: { tool: 0, block: 0, final: 1 },
      };
    }) as DispatchReplyWithBufferedBlockDispatcher;

    await recordInboundSessionAndDispatchReply({
      cfg: {} as OpenClawConfig,
      channel: "telegram",
      accountId: "default",
      agentId: "main",
      routeSessionKey: "agent:main:telegram:peer",
      storePath: "/tmp/sessions.json",
      ctxPayload: {
        Body: "body",
        RawBody: "body",
        CommandBody: "body",
        From: "sender",
        To: "123",
        OriginatingTo: "123",
        SessionKey: "agent:main:telegram:peer",
        Provider: "telegram",
        Surface: "telegram",
      } as FinalizedMsgContext,
      recordInboundSession,
      dispatchReplyWithBufferedBlockDispatcher,
      deliver,
      onRecordError: vi.fn(),
      onDispatchError: vi.fn(),
    });

    expect(deliver).toHaveBeenCalledWith({
      text: "hello",
      mediaUrl: undefined,
      mediaUrls: undefined,
      sensitiveMedia: undefined,
      replyToId: undefined,
    });
  });

  it("forwards durable delivery options through the SDK convenience wrapper", async () => {
    deliverDurableInboundReplyPayload.mockResolvedValue({
      messageIds: ["queued-1"],
      visibleReplySent: true,
    });
    const recordInboundSession = vi.fn(async () => undefined) as unknown as RecordInboundSession;
    const deliver = vi.fn(async () => undefined);
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async (params) => {
      await params.dispatcherOptions.deliver({ text: "hello durable" }, { kind: "final" });
      return {
        queuedFinal: true,
        counts: { tool: 0, block: 0, final: 1 },
      };
    }) as DispatchReplyWithBufferedBlockDispatcher;
    const ctxPayload = {
      Body: "body",
      RawBody: "body",
      CommandBody: "body",
      From: "sender",
      To: "123",
      OriginatingTo: "123",
      SessionKey: "agent:main:telegram:peer",
      Provider: "telegram",
      Surface: "telegram",
    } as FinalizedMsgContext;

    await dispatchInboundReplyWithBase({
      cfg: {} as OpenClawConfig,
      channel: "telegram",
      accountId: "default",
      route: {
        agentId: "main",
        sessionKey: "agent:main:telegram:peer",
      },
      storePath: "/tmp/sessions.json",
      ctxPayload,
      core: {
        channel: {
          session: { recordInboundSession },
          reply: { dispatchReplyWithBufferedBlockDispatcher },
        },
      },
      deliver,
      durable: { replyToMode: "first" },
      onRecordError: vi.fn(),
      onDispatchError: vi.fn(),
    });

    expect(deliverDurableInboundReplyPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        accountId: "default",
        agentId: "main",
        ctxPayload,
        payload: expect.objectContaining({ text: "hello durable" }),
        info: { kind: "final" },
        replyToMode: "first",
      }),
    );
    expect(deliver).not.toHaveBeenCalled();
  });

  it("exports shared visible reply dispatch helpers", () => {
    expect(hasVisibleInboundReplyDispatch(undefined)).toBe(false);
    expect(
      hasVisibleInboundReplyDispatch({
        queuedFinal: false,
        counts: { tool: 0, block: 1, final: 0 },
      }),
    ).toBe(true);
    expect(
      hasFinalInboundReplyDispatch({
        queuedFinal: false,
        counts: { tool: 0, block: 1, final: 0 },
      }),
    ).toBe(false);
    expect(
      hasFinalInboundReplyDispatch(undefined, {
        fallbackDelivered: true,
      }),
    ).toBe(true);
    expect(resolveInboundReplyDispatchCounts(undefined)).toEqual({
      tool: 0,
      block: 0,
      final: 0,
    });
  });
});
