import { TrueForge, TrueForgeApi, isEventDelta, mergeEventDelta } from "@truefoundry/trueforge-sdk";

export type KnownEventType =
  | "turn.created"
  | "model.message"
  | "model.message.delta"
  | "turn.update"
  | "tool.approval_required"
  | "tool.response_required"
  | "mcp.auth_required"
  | "turn.done"
  | "unknown";

export type TerminalTurnStatus = "done" | "cancelled" | "error";

export interface ClassifiedEvent {
  id?: string;
  type: KnownEventType | string;
  turnId?: string;
  deltaText?: string;
  messageText?: string;
  terminalStatus?: TerminalTurnStatus;
  terminalReason?: string;
  isUnsupportedInM0: boolean;
  unsupportedReason?: string;
  rawEvent: TrueForgeApi.TurnStreamingEvent | Record<string, unknown>;
}

/**
 * Classifies a TrueForge SSE streaming event into PatchPilot's internal normalized representation.
 */
export function classifyTurnEvent(
  event: TrueForgeApi.TurnStreamingEvent | Record<string, unknown>
): ClassifiedEvent {
  const raw = event as Record<string, unknown>;
  const eventType = typeof raw.type === "string" ? raw.type : "unknown";
  const eventId = typeof raw.id === "string" ? raw.id : undefined;

  const result: ClassifiedEvent = {
    id: eventId,
    type: eventType,
    isUnsupportedInM0: false,
    rawEvent: event as TrueForgeApi.TurnStreamingEvent,
  };

  switch (eventType) {
    case "turn.created": {
      const turnCreated = event as TrueForgeApi.TurnCreatedEvent;
      result.turnId = turnCreated.turnId;
      break;
    }

    case "model.message.delta": {
      const delta = event as TrueForgeApi.ModelMessageDeltaEvent;
      if (typeof delta.content === "string") {
        result.deltaText = delta.content;
      }
      break;
    }

    case "model.message": {
      const msg = event as TrueForgeApi.ModelMessageEvent;
      if (typeof msg.content === "string") {
        result.messageText = msg.content;
      } else if (Array.isArray(msg.content)) {
        // Content parts
        const parts: string[] = [];
        for (const p of msg.content) {
          if (p && typeof p === "object" && "text" in p && typeof (p as { text: unknown }).text === "string") {
            parts.push((p as { text: string }).text);
          }
        }
        result.messageText = parts.join("");
      }
      break;
    }

    case "turn.update": {
      // General turn status update
      break;
    }

    case "turn.done": {
      const done = event as TrueForgeApi.TurnDoneEvent;
      const state = done.state;
      if (state) {
        if (state.status === "done" || state.status === "cancelled" || state.status === "error") {
          result.terminalStatus = state.status;
        } else {
          result.terminalStatus = "done";
        }

        if ("message" in state && typeof (state as { message?: unknown }).message === "string") {
          result.terminalReason = (state as { message: string }).message;
        } else if ("reason" in state && typeof (state as { reason?: unknown }).reason === "string") {
          result.terminalReason = (state as { reason: string }).reason;
        }
      }
      break;
    }

    case "tool.approval_required":
    case "tool.response_required":
    case "mcp.auth_required": {
      result.isUnsupportedInM0 = true;
      result.unsupportedReason = `Received '${eventType}' event. Interactive approval and tool handling is not supported in Milestone 0.`;
      break;
    }

    default: {
      // Check for other action_required or approval types
      if (eventType.includes("approval") || eventType.includes("response_required")) {
        result.isUnsupportedInM0 = true;
        result.unsupportedReason = `Received interactive event '${eventType}'. Unsupported in Milestone 0.`;
      }
      break;
    }
  }

  return result;
}

export { isEventDelta, mergeEventDelta };
