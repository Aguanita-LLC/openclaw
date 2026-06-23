import type { AcpRuntimeEvent } from "../../acp/runtime/types.js";

export type CuratedMessage = {
  kind: "codex-reply";
  text: string;
};

export type AcpDriveCurationContext = {
  turnId?: string;
  surfacedTurnIds?: Set<string>;
};

function assertNever(value: never): never {
  throw new Error(`Unhandled ACP runtime event: ${JSON.stringify(value)}`);
}

function markTurnSurfaced(context: AcpDriveCurationContext | undefined): boolean {
  const turnId = context?.turnId?.trim();
  if (!turnId || !context?.surfacedTurnIds) {
    return true;
  }
  if (context.surfacedTurnIds.has(turnId)) {
    return false;
  }
  context.surfacedTurnIds.add(turnId);
  return true;
}

function buildErrorText(event: Extract<AcpRuntimeEvent, { type: "error" }>): string {
  const message = event.message.trim() || "unknown error";
  return `ACP session error: ${message}`;
}

export function curateAcpRuntimeEvents(
  events: AcpRuntimeEvent[],
  context?: AcpDriveCurationContext,
): CuratedMessage[] {
  let output = "";
  const messages: CuratedMessage[] = [];

  for (const event of events) {
    switch (event.type) {
      case "text_delta":
        if (event.stream && event.stream !== "output") {
          break;
        }
        output += event.text;
        break;
      case "status":
      case "tool_call":
        break;
      case "done": {
        const text = output.trim();
        output = "";
        if (text && markTurnSurfaced(context)) {
          messages.push({ kind: "codex-reply", text });
        }
        break;
      }
      case "error": {
        output = "";
        if (markTurnSurfaced(context)) {
          messages.push({ kind: "codex-reply", text: buildErrorText(event) });
        }
        break;
      }
      default:
        assertNever(event);
    }
  }

  return messages;
}
