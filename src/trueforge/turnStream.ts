import { TrueForge, TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { TrueForgeResolvedConfig } from "../config/configuration";
import { ILogger } from "../output/logger";
import { sanitizeSecretText } from "../security/secretFilter";
import { ExtensionState, TurnStatus } from "../state/extensionState";
import { ApprovalManager, PendingToolApproval } from "./approvalManager";
import { ITrueForgeClientFactory } from "./clientFactory";
import { TrueForgeStreamError } from "./errors";
import { classifyTurnEvent, ExtractedToolCall } from "./eventTypes";

export interface TurnStreamCallbacks {
  onTurnCreated?: (turnId: string) => void;
  onDelta?: (deltaText: string) => void;
  onReasoningDelta?: (deltaText: string) => void;
  onMessage?: (text: string, modelName?: string) => void;
  onToolCall?: (toolCall: ExtractedToolCall) => void;
  onToolResponse?: (toolCallId: string, toolName: string, content: string) => void;
  onApprovalRequired?: (approvals: PendingToolApproval[]) => void;
  onCompaction?: (phase: "started" | "finished") => void;
  onRetry?: (attempt: number, maxAttempts: number, delayMs: number, reason: string) => void;
  onTurnDone?: (status: TurnStatus, reason?: string) => void;
}

export interface ExecuteTurnOptions {
  abortSignal?: AbortSignal;
  approvalManager?: ApprovalManager;
  callbacks?: TurnStreamCallbacks;
  maxRetries?: number;
  baseRetryDelayMs?: number;
}

export interface TurnExecutionResult {
  sessionId: string;
  turnId?: string;
  terminalStatus: TurnStatus;
  accumulatedText: string;
  eventsCount: number;
  lastEventId?: string;
  toolCalls: ExtractedToolCall[];
  unsupportedEvents: string[];
  retriesPerformed: number;
  modelName?: string;
  error?: string;
}

/**
 * Classifies whether a TrueForge error is retryable (transient network / 5xx / 429 rate-limit)
 * versus non-retryable (401/403 auth errors, 400 validation, AbortError).
 */
export function isRetryableTrueForgeError(err: unknown): boolean {
  if (!err) {
    return false;
  }
  const name = (err as { name?: string }).name || "";
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const statusCode = (err as { statusCode?: number }).statusCode;

  if (name === "AbortError" || msg.includes("abort")) {
    return false;
  }
  if (
    statusCode === 400 ||
    statusCode === 401 ||
    statusCode === 403 ||
    statusCode === 404 ||
    statusCode === 412 ||
    statusCode === 422
  ) {
    return false;
  }
  if (
    msg.includes("401") ||
    msg.includes("403") ||
    msg.includes("unauthorized") ||
    msg.includes("invalid api key") ||
    msg.includes("incorrect api key")
  ) {
    return false;
  }
  if (
    statusCode === 429 ||
    (typeof statusCode === "number" && statusCode >= 500 && statusCode <= 599) ||
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("timeout") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("socket hang up") ||
    msg.includes("fetch failed")
  ) {
    return true;
  }
  return false;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class TurnStreamManager {
  private clientFactory: ITrueForgeClientFactory;
  private state: ExtensionState;
  private logger: ILogger;

  constructor(
    clientFactory: ITrueForgeClientFactory,
    state: ExtensionState,
    logger: ILogger
  ) {
    this.clientFactory = clientFactory;
    this.state = state;
    this.logger = logger;
  }

  /**
   * Dispatches a user prompt to TrueForge, consumes SSE events incrementally, handles
   * real human-in-the-loop tool approvals (via ApprovalManager + subscribeToTurn),
   * and applies bounded exponential backoff for retryable transport failures.
   */
  public async executeTurn(
    config: TrueForgeResolvedConfig,
    sessionId: string,
    message: string,
    options?: ExecuteTurnOptions
  ): Promise<TurnExecutionResult> {
    if (!message || message.trim().length === 0) {
      throw new TrueForgeStreamError("Cannot dispatch empty user message.", sessionId);
    }

    if (!this.state.acquireSendMessageGuard()) {
      throw new TrueForgeStreamError(
        "A turn is already running or being submitted. Please wait or cancel the active turn.",
        sessionId,
        this.state.activeTurnId
      );
    }

    const localAbortController = new AbortController();
    this.state.setActiveAbortController(localAbortController);

    if (options?.abortSignal) {
      if (options.abortSignal.aborted) {
        localAbortController.abort();
      } else {
        options.abortSignal.addEventListener("abort", () => localAbortController.abort(), {
          once: true,
        });
      }
    }

    this.state.setActiveTurn(undefined, "RUNNING");
    this.logger.info(`--- Starting Turn in Session: ${sessionId} ---`);
    this.logger.info(`User Input: "${sanitizeSecretText(message.trim()).slice(0, 400)}"`);

    const client = this.clientFactory.createClient(config);
    const maxRetries = options?.maxRetries ?? 2;
    const baseRetryDelayMs = options?.baseRetryDelayMs ?? 500;
    const callbacks = options?.callbacks;
    const approvalManager = options?.approvalManager;

    const result: TurnExecutionResult = {
      sessionId,
      terminalStatus: "RUNNING",
      accumulatedText: "",
      eventsCount: 0,
      toolCalls: [],
      unsupportedEvents: [],
      retriesPerformed: 0,
    };

    const seenEventIds = new Set<string>();
    const toolCallsById = new Map<string, ExtractedToolCall>();
    let hasStreamedDeltasInCurrentMsg = false;

    const consumeStream = async (
      stream: AsyncIterable<TrueForgeApi.TurnStreamingEvent | Record<string, unknown>>
    ): Promise<{ pausedForApproval: boolean; approvalWaiters: Array<Promise<{ allow: boolean; reason?: string }>> }> => {
      let pausedForApproval = false;
      const approvalWaiters: Array<Promise<{ allow: boolean; reason?: string }>> = [];

      for await (const rawEvent of stream) {
        const classified = classifyTurnEvent(rawEvent);

        // Deduplicate replayed events on reconnection
        if (classified.id) {
          if (seenEventIds.has(classified.id)) {
            continue;
          }
          seenEventIds.add(classified.id);
          result.lastEventId = classified.id;
          this.state.setLastEventId(classified.id);
        }

        result.eventsCount++;

        switch (classified.type) {
          case "turn.created": {
            if (classified.turnId) {
              result.turnId = classified.turnId;
              this.state.setActiveTurn(classified.turnId, "RUNNING");
              this.logger.info(`[EVENT: turn.created] Active Turn ID: ${classified.turnId}`);
              callbacks?.onTurnCreated?.(classified.turnId);
            }
            break;
          }

          case "model.message.delta": {
            if (classified.deltaText) {
              hasStreamedDeltasInCurrentMsg = true;
              this.state.appendTurnText(classified.deltaText);
              result.accumulatedText += classified.deltaText;
              this.logger.streamChunk(classified.deltaText);
              callbacks?.onDelta?.(classified.deltaText);
            }
            if (classified.reasoningDelta) {
              callbacks?.onReasoningDelta?.(classified.reasoningDelta);
            }
            break;
          }

          case "model.message": {
            if (classified.modelName) {
              result.modelName = classified.modelName;
            }
            if (!hasStreamedDeltasInCurrentMsg && classified.messageText) {
              this.state.appendTurnText(classified.messageText);
              result.accumulatedText += classified.messageText;
              this.logger.info(`[EVENT: model.message] ${classified.messageText}`);
              callbacks?.onMessage?.(classified.messageText, classified.modelName);
            }
            hasStreamedDeltasInCurrentMsg = false;

            if (classified.toolCalls && classified.toolCalls.length > 0) {
              for (const tc of classified.toolCalls) {
                toolCallsById.set(tc.id, tc);
                result.toolCalls.push(tc);
                this.logger.info(
                  `[EVENT: tool.call] ${tc.name} (id=${tc.id}, args=${sanitizeSecretText(tc.argumentsRaw).slice(0, 240)})`
                );
                callbacks?.onToolCall?.(tc);
              }
            }
            break;
          }

          case "tool.response": {
            const callId = classified.toolResponseCallId || "unknown";
            const toolName = toolCallsById.get(callId)?.name || "tool";
            const content = sanitizeSecretText(classified.toolResponseContent || "");
            this.logger.info(
              `[EVENT: tool.response] ${toolName} (id=${callId}, ${content.length} chars)`
            );
            callbacks?.onToolResponse?.(callId, toolName, content);
            break;
          }

          case "thread.context_compaction.started": {
            this.logger.info("[EVENT: context_compaction.started] TrueForge compacting context...");
            callbacks?.onCompaction?.("started");
            break;
          }

          case "thread.context_compaction.finished": {
            this.logger.info("[EVENT: context_compaction.finished] TrueForge compaction completed.");
            callbacks?.onCompaction?.("finished");
            break;
          }

          case "tool.approval_required": {
            if (approvalManager && result.turnId && classified.approvalRefs && classified.approvalRefs.length > 0) {
              this.state.setTurnStatus("PAUSED");
              result.terminalStatus = "PAUSED";
              pausedForApproval = true;

              const pendingBatch: PendingToolApproval[] = [];
              for (const ref of classified.approvalRefs) {
                const matchedCall = toolCallsById.get(ref.toolCallId);
                const waiter = approvalManager.registerPendingApproval({
                  sessionId,
                  turnId: result.turnId,
                  threadId: classified.threadId || "main",
                  toolCallId: ref.toolCallId,
                  sourceEventId: ref.sourceEventId,
                  toolName: matchedCall?.name || "workspace_tool",
                  argumentsRaw: matchedCall?.argumentsRaw || "{}",
                  parsedArguments: matchedCall?.parsedArguments,
                });
                approvalWaiters.push(waiter);
                const createdRecord = approvalManager
                  .getPendingApprovals()
                  .find((a) => a.toolCallId === ref.toolCallId);
                if (createdRecord) {
                  pendingBatch.push(createdRecord);
                }
              }

              callbacks?.onApprovalRequired?.(pendingBatch);
            } else {
              result.unsupportedEvents.push(classified.type);
              this.logger.warn(`[UNSUPPORTED] ${classified.unsupportedReason}`);
              this.state.setTurnStatus("PAUSED");
              result.terminalStatus = "PAUSED";
            }
            break;
          }

          case "tool.response_required":
          case "mcp.auth_required": {
            result.unsupportedEvents.push(classified.type);
            this.logger.warn(`[UNSUPPORTED] ${classified.unsupportedReason}`);
            this.state.setTurnStatus("PAUSED");
            result.terminalStatus = "PAUSED";
            break;
          }

          case "turn.update": {
            this.logger.debug(`[EVENT: turn.update] status=${classified.liveTurnStatus || "unknown"}`);
            break;
          }

          case "turn.done": {
            this.logger.streamChunk("\n");
            const termStatus = classified.terminalStatus || "done";
            if (termStatus === "cancelled") {
              this.state.setTurnStatus("CANCELLED");
              result.terminalStatus = "CANCELLED";
            } else if (termStatus === "error") {
              this.state.setTurnStatus("ERROR");
              result.terminalStatus = "ERROR";
              result.error = classified.terminalReason
                ? sanitizeSecretText(classified.terminalReason)
                : "TrueForge turn ended in error state.";
            } else {
              this.state.setTurnStatus("COMPLETED");
              result.terminalStatus = "COMPLETED";
            }
            this.logger.info(
              `[EVENT: turn.done] Terminal Status: ${termStatus}` +
              (classified.terminalReason ? ` (Reason: ${sanitizeSecretText(classified.terminalReason)})` : "")
            );
            callbacks?.onTurnDone?.(result.terminalStatus, result.error);
            break;
          }

          default: {
            if (classified.isUnsupportedInM0) {
              result.unsupportedEvents.push(classified.type);
              this.logger.warn(`[UNSUPPORTED] ${classified.unsupportedReason}`);
            }
            break;
          }
        }
      }

      return { pausedForApproval, approvalWaiters };
    };

    try {
      // Open initial turn stream with bounded exponential backoff ONLY for retryable transport failures
      let initialStream: AsyncIterable<TrueForgeApi.TurnStreamingEvent> | undefined;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          initialStream = await client.sessions.createTurnStream(
            sessionId,
            {
              input: [
                {
                  type: "user.message",
                  content: message.trim(),
                },
              ],
            },
            {
              abortSignal: localAbortController.signal,
            }
          );
          break;
        } catch (openErr: unknown) {
          if (attempt < maxRetries && isRetryableTrueForgeError(openErr)) {
            result.retriesPerformed++;
            const delayMs = baseRetryDelayMs * Math.pow(2, attempt);
            const reason = sanitizeSecretText(
              openErr instanceof Error ? openErr.message : String(openErr)
            );
            this.logger.warn(
              `Retryable TrueForge error on attempt ${attempt + 1}/${maxRetries + 1}: ${reason}. Retrying in ${delayMs}ms...`
            );
            callbacks?.onRetry?.(attempt + 1, maxRetries, delayMs, reason);
            await sleep(delayMs, localAbortController.signal);
            continue;
          }
          throw openErr;
        }
      }

      this.logger.info("SSE turn stream connection established. Receiving events...");
      let streamOutcome = await consumeStream(initialStream!);

      // Interactive approval resume loop: wait for human decisions, then subscribeToTurn to continue!
      while (
        streamOutcome.pausedForApproval &&
        streamOutcome.approvalWaiters.length > 0 &&
        result.turnId &&
        !localAbortController.signal.aborted
      ) {
        await Promise.all(streamOutcome.approvalWaiters);
        if (localAbortController.signal.aborted) {
          break;
        }
        this.state.setTurnStatus("RUNNING");
        result.terminalStatus = "RUNNING";
        this.logger.info(
          `Resuming TrueForge turn ${result.turnId} stream after human tool approval (afterEventId=${result.lastEventId || "none"})...`
        );
        const resumedStream = await client.sessions.subscribeToTurn(
          sessionId,
          result.turnId,
          result.lastEventId ? { afterEventId: result.lastEventId } : {},
          { abortSignal: localAbortController.signal }
        );
        streamOutcome = await consumeStream(resumedStream);
      }

      // Verify authoritative server state when turnId is known
      if (result.turnId) {
        try {
          const authTurn = await client.sessions.getTurn(sessionId, result.turnId);
          const serverStatus = authTurn.data.state?.status;
          this.logger.info(`Authoritative server turn status: ${serverStatus}`);

          if (serverStatus === "cancelled") {
            result.terminalStatus = "CANCELLED";
            this.state.setTurnStatus("CANCELLED");
          } else if (serverStatus === "error") {
            result.terminalStatus = "ERROR";
            this.state.setTurnStatus("ERROR");
            const stateObj = authTurn.data.state as { message?: string };
            if (!result.error && stateObj.message) {
              result.error = sanitizeSecretText(stateObj.message);
            }
          } else if (serverStatus === "done") {
            result.terminalStatus = "COMPLETED";
            this.state.setTurnStatus("COMPLETED");
          }
        } catch (authErr: unknown) {
          this.logger.warn(
            `Could not query authoritative turn status: ${sanitizeSecretText(authErr instanceof Error ? authErr.message : String(authErr))}`
          );
        }
      }

      return result;
    } catch (err: unknown) {
      const errMsg = sanitizeSecretText(err instanceof Error ? err.message : String(err));
      const isAbort =
        (err as { name?: string })?.name === "AbortError" ||
        localAbortController.signal.aborted ||
        errMsg.toLowerCase().includes("abort");

      if (isAbort) {
        this.logger.warn("Client turn stream aborted locally.");
        this.state.setTurnStatus("CANCELLED");
        result.terminalStatus = "CANCELLED";
        result.error = "Turn stream cancelled by client.";
        callbacks?.onTurnDone?.("CANCELLED", result.error);
        return result;
      }

      this.logger.error(`Turn stream encountered an error: ${errMsg}`);
      this.state.setTurnStatus("ERROR");
      result.terminalStatus = "ERROR";
      result.error = errMsg;
      callbacks?.onTurnDone?.("ERROR", errMsg);
      throw new TrueForgeStreamError(
        `Turn stream error: ${errMsg}`,
        sessionId,
        result.turnId,
        result.lastEventId
      );
    } finally {
      this.state.releaseSendMessageGuard();
      this.state.setActiveAbortController(undefined);
    }
  }

  /**
   * Reconnects to an active or interrupted turn using TrueForge SDK subscribeToTurn.
   */
  public async recoverTurn(
    config: TrueForgeResolvedConfig,
    sessionId: string,
    turnId: string,
    lastEventId?: string
  ): Promise<TurnExecutionResult> {
    this.logger.info(`--- Attempting Turn Recovery: Session ${sessionId}, Turn ${turnId} ---`);
    const client = this.clientFactory.createClient(config);

    let serverStatus: string | undefined;
    try {
      const turnResp = await client.sessions.getTurn(sessionId, turnId);
      serverStatus = turnResp.data.state?.status;
      this.logger.info(`Retrieved authoritative turn status: ${serverStatus}`);
    } catch (err: unknown) {
      const errMsg = sanitizeSecretText(err instanceof Error ? err.message : String(err));
      this.logger.error(`Failed to retrieve authoritative turn state: ${errMsg}`);
      throw new TrueForgeStreamError(`Cannot recover turn: ${errMsg}`, sessionId, turnId);
    }

    const result: TurnExecutionResult = {
      sessionId,
      turnId,
      terminalStatus: "RUNNING",
      accumulatedText: this.state.turnAccumulatedText,
      eventsCount: 0,
      toolCalls: [],
      unsupportedEvents: [],
      retriesPerformed: 0,
    };

    if (serverStatus === "done") {
      this.state.setTurnStatus("COMPLETED");
      result.terminalStatus = "COMPLETED";
      this.logger.info(`Turn ${turnId} already completed on server. No stream reconnection needed.`);
      return result;
    }
    if (serverStatus === "cancelled") {
      this.state.setTurnStatus("CANCELLED");
      result.terminalStatus = "CANCELLED";
      this.logger.info(`Turn ${turnId} was cancelled on server.`);
      return result;
    }
    if (serverStatus === "error") {
      this.state.setTurnStatus("ERROR");
      result.terminalStatus = "ERROR";
      this.logger.warn(`Turn ${turnId} failed in error state on server.`);
      return result;
    }
    if (serverStatus === "paused") {
      this.state.setTurnStatus("PAUSED");
      result.terminalStatus = "PAUSED";
      this.logger.warn(`Turn ${turnId} is currently paused awaiting interaction.`);
      return result;
    }

    this.logger.info(
      `Turn ${turnId} is still running. Subscribing to stream afterEventId: ${lastEventId || "tip"}...`
    );
    try {
      const subscribeStream = await client.sessions.subscribeToTurn(
        sessionId,
        turnId,
        lastEventId ? { afterEventId: lastEventId } : {}
      );

      for await (const rawEvent of subscribeStream) {
        result.eventsCount++;
        const classified = classifyTurnEvent(rawEvent);
        if (classified.id) {
          result.lastEventId = classified.id;
          this.state.setLastEventId(classified.id);
        }

        if (classified.type === "model.message.delta" && classified.deltaText) {
          result.accumulatedText += classified.deltaText;
          this.state.appendTurnText(classified.deltaText);
          this.logger.streamChunk(classified.deltaText);
        } else if (classified.type === "turn.done") {
          const termStatus = classified.terminalStatus || "done";
          if (termStatus === "cancelled") {
            result.terminalStatus = "CANCELLED";
            this.state.setTurnStatus("CANCELLED");
          } else if (termStatus === "error") {
            result.terminalStatus = "ERROR";
            this.state.setTurnStatus("ERROR");
          } else {
            result.terminalStatus = "COMPLETED";
            this.state.setTurnStatus("COMPLETED");
          }
          this.logger.info(`[RECOVERY STREAM DONE] Terminal status: ${termStatus}`);
        }
      }

      return result;
    } catch (subErr: unknown) {
      const subErrMsg = sanitizeSecretText(
        subErr instanceof Error ? subErr.message : String(subErr)
      );
      this.logger.error(`Reconnection subscription error: ${subErrMsg}`);
      throw new TrueForgeStreamError(
        `Subscription recovery failed: ${subErrMsg}`,
        sessionId,
        turnId,
        lastEventId
      );
    }
  }
}
