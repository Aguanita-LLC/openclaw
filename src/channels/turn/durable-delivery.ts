import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeDeliverableOutboundChannel } from "../../infra/outbound/channel-resolution.js";
import {
  deliverOutboundPayloads,
  type DeliverOutboundPayloadsParams,
} from "../../infra/outbound/deliver.js";
import { buildOutboundSessionContext } from "../../infra/outbound/session-context.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { ChannelDeliveryInfo, ChannelDeliveryResult } from "./types.js";

export type DurableInboundReplyDeliveryOptions = Pick<
  DeliverOutboundPayloadsParams,
  "deps" | "formatting" | "identity" | "mediaAccess" | "replyToMode" | "silent" | "threadId"
> & {
  to?: string | null;
  replyToId?: string | null;
};

export type DurableInboundReplyDeliveryParams = DurableInboundReplyDeliveryOptions & {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
  agentId: string;
  ctxPayload: FinalizedMsgContext;
  payload: ReplyPayload;
  info: ChannelDeliveryInfo;
};

function resolveDeliveryTarget(params: DurableInboundReplyDeliveryParams): string | undefined {
  return (
    normalizeOptionalString(params.to) ??
    normalizeOptionalString(params.ctxPayload.OriginatingTo) ??
    normalizeOptionalString(params.ctxPayload.To)
  );
}

function resolveReplyToId(params: DurableInboundReplyDeliveryParams): string | null | undefined {
  return (
    normalizeOptionalString(params.replyToId) ??
    normalizeOptionalString(params.payload.replyToId) ??
    normalizeOptionalString(params.ctxPayload.ReplyToIdFull) ??
    normalizeOptionalString(params.ctxPayload.ReplyToId)
  );
}

function resolveThreadId(
  params: DurableInboundReplyDeliveryParams,
): string | number | null | undefined {
  return params.threadId ?? params.ctxPayload.MessageThreadId;
}

function stringifyThreadId(value: string | number | null | undefined): string | undefined {
  return value == null ? undefined : String(value);
}

function collectMessageIds(results: Awaited<ReturnType<typeof deliverOutboundPayloads>>): string[] {
  return results.map((result) => result.messageId).filter((id) => id.length > 0);
}

function isMissingOutboundHandlerError(err: unknown, channel: string): boolean {
  return err instanceof Error && err.message === `Outbound not configured for channel: ${channel}`;
}

export async function deliverDurableInboundReplyPayload(
  params: DurableInboundReplyDeliveryParams,
): Promise<ChannelDeliveryResult | null> {
  if (params.info.kind !== "final") {
    return null;
  }

  const channel = normalizeDeliverableOutboundChannel(params.channel);
  const to = resolveDeliveryTarget(params);
  if (!channel || !to) {
    return null;
  }

  const replyToId = resolveReplyToId(params);
  const threadId = resolveThreadId(params);
  const results = await deliverOutboundPayloads({
    cfg: params.cfg,
    channel,
    to,
    accountId: params.accountId,
    payloads: [params.payload],
    threadId,
    replyToId,
    replyToMode: params.replyToMode,
    formatting: params.formatting,
    identity: params.identity,
    deps: params.deps,
    mediaAccess: params.mediaAccess,
    silent: params.silent,
    session: buildOutboundSessionContext({
      cfg: params.cfg,
      sessionKey: params.ctxPayload.SessionKey,
      policySessionKey: params.ctxPayload.RuntimePolicySessionKey,
      conversationType: params.ctxPayload.ChatType,
      agentId: params.agentId,
      requesterAccountId: params.accountId ?? params.ctxPayload.AccountId,
      requesterSenderId: params.ctxPayload.SenderId ?? params.ctxPayload.From,
      requesterSenderName: params.ctxPayload.SenderName,
      requesterSenderUsername: params.ctxPayload.SenderUsername,
      requesterSenderE164: params.ctxPayload.SenderE164,
    }),
    gatewayClientScopes: params.ctxPayload.GatewayClientScopes,
  }).catch((err: unknown) => {
    if (isMissingOutboundHandlerError(err, channel)) {
      return null;
    }
    throw err;
  });

  if (!results) {
    return null;
  }

  const messageIds = collectMessageIds(results);
  return {
    ...(messageIds.length > 0 ? { messageIds } : {}),
    threadId: stringifyThreadId(threadId),
    ...(replyToId ? { replyToId } : {}),
    visibleReplySent: results.length > 0,
  };
}
