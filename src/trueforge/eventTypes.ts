import { TrueForgeApi, isEventDelta, mergeEventDelta } from "@truefoundry/trueforge-sdk";

export type KnownEventType =
  | "turn.created"
  | "model.message"
  | "model.message.delta"
  | "tool.response"
  | "tool.approval_required"
  | "tool.response_required"
  | "mcp.auth_required"
  | "mcp.initialize"
  | "thread.context_compaction.started"
  | "thread.context_compaction.finished"
  | "turn.update"
  | "turn.done"
  | "unknown";

export type TerminalTurnStatus = "done" | "cancelled" | "error";

export interface ExtractedToolCall {
  id: string;
  name: string;
  serverName?: string;
  argumentsRaw: string;
  parsedArguments?: Record<string, unknown>;
}

export interface ExtractedApprovalRef {
  toolCallId: string;
  sourceEventId: string;
}

export interface ClassifiedEvent {
  id?: string;
  type: KnownEventType | string;
  threadId?: string;
  turnId?: string;
  deltaText?: string;
  reasoningDelta?: string;
  messageText?: string;
  toolCalls?: ExtractedToolCall[];
  approvalRefs?: ExtractedApprovalRef[];
  toolResponseCallId?: string;
  toolResponseContent?: string;
  liveTurnStatus?: string;
  terminalStatus?: TerminalTurnStatus;
  terminalReason?: string;
  modelName?: string;
  /** Preserved for Milestone 0 compatibility checks */
  isUnsupportedInM0: boolean;
  unsupportedReason?: string;
  rawEvent: TrueForgeApi.TurnStreamingEvent | Record<string, unknown>;
}

function tryParseJsonObject(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Non-JSON or partial arguments
  }
  return undefined;
}

/**
 * Classifies a TrueForge SSE streaming event into PatchPilot's normalized event structure.
 */
export function classifyTurnEvent(
  event: TrueForgeApi.TurnStreamingEvent | Record<string, unknown>
): ClassifiedEvent {
  const raw = event as Record<string, unknown>;
  const eventType = typeof raw.type === "string" ? raw.type : "unknown";
  const eventId = typeof raw.id === "string" ? raw.id : undefined;
  const threadId = typeof raw.threadId === "string" ? raw.threadId : undefined;

  const result: ClassifiedEvent = {
    id: eventId,
    type: eventType,
    threadId,
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
      if (typeof delta.reasoningContent === "string") {
        result.reasoningDelta = delta.reasoningContent;
      }
      break;
    }

    case "model.message": {
      const msg = event as TrueForgeApi.ModelMessageEvent;
      if (msg.model && typeof msg.model.name === "string") {
        result.modelName = msg.model.name;
      }
      if (typeof msg.content === "string") {
        result.messageText = msg.content;
      } else if (Array.isArray(msg.content)) {
        const parts: string[] = [];
        for (const p of msg.content) {
          if (p && typeof p === "object" && "text" in p && typeof (p as { text: unknown }).text === "string") {
            parts.push((p as { text: string }).text);
          }
        }
        result.messageText = parts.join("");
      }

      if (Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) {
        result.toolCalls = msg.toolCalls.map((tc) => {
          const fnName = tc.function?.name || "unknown_tool";
          const argsRaw = typeof tc.function?.arguments === "string" ? tc.function.arguments : "{}";
          const parsedArguments = tryParseJsonObject(argsRaw);
          const info = tc.toolInfo as { type?: string; name?: string; serverName?: string } | undefined;

          // When TrueForge uses deferred MCP loading (preload: false), tool calls are
          // wrapped in TrueForge's system tool "call_tool" with { mcp_server, tool_name, input }.
          let resolvedName = info?.name || fnName;
          let resolvedServer = info?.serverName;
          let resolvedArgsRaw = argsRaw;
          let resolvedParsed = parsedArguments;

          const wrappedToolName =
            typeof parsedArguments?.tool_name === "string"
              ? parsedArguments.tool_name
              : typeof parsedArguments?.tool === "string"
                ? parsedArguments.tool
                : undefined;

          if (resolvedName === "call_tool" && parsedArguments && wrappedToolName) {
            resolvedName = wrappedToolName;
            if (typeof parsedArguments.mcp_server === "string") {
              resolvedServer = parsedArguments.mcp_server;
            }
            if (parsedArguments.input && typeof parsedArguments.input === "object") {
              resolvedParsed = parsedArguments.input as Record<string, unknown>;
              resolvedArgsRaw = JSON.stringify(parsedArguments.input);
            }
          }

          return {
            id: tc.id,
            name: resolvedName,
            serverName: resolvedServer,
            argumentsRaw: resolvedArgsRaw,
            parsedArguments: resolvedParsed,
          };
        });
      }
      break;
    }

    case "tool.response": {
      const resp = event as TrueForgeApi.ToolResponseEvent;
      result.toolResponseCallId = resp.toolCallId;
      result.toolResponseContent = resp.content;
      break;
    }

    case "tool.approval_required": {
      const appr = event as TrueForgeApi.ToolApprovalRequiredEvent;
      result.isUnsupportedInM0 = true;
      result.unsupportedReason =
        "Received 'tool.approval_required' event. Interactive approval and tool handling is not supported in Milestone 0.";
      if (Array.isArray(appr.toolCalls)) {
        result.approvalRefs = appr.toolCalls.map((ref) => ({
          toolCallId: ref.id,
          sourceEventId: ref.sourceEventId,
        }));
      }
      break;
    }

    case "tool.response_required":
    case "mcp.auth_required": {
      result.isUnsupportedInM0 = true;
      result.unsupportedReason = `Received '${eventType}' event. Interactive approval and tool handling is not supported in Milestone 0.`;
      break;
    }

    case "turn.update": {
      const upd = event as TrueForgeApi.TurnUpdateEvent;
      if (upd.state && typeof upd.state.status === "string") {
        result.liveTurnStatus = upd.state.status;
      }
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

    case "thread.context_compaction.started":
    case "thread.context_compaction.finished":
    case "mcp.initialize": {
      break;
    }

    default: {
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
