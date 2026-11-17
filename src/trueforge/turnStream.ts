import { TrueForge, TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { TrueForgeResolvedConfig } from "../config/configuration";
import { ExtensionState, TurnStatus } from "../state/extensionState";
import { ILogger } from "../output/logger";
import { ITrueForgeClientFactory } from "./clientFactory";
import { classifyTurnEvent, ClassifiedEvent } from "./eventTypes";
import { TrueForgeStreamError, TrueForgeTurnError, TrueForgeUnsupportedEventError } from "./errors";

export interface TurnExecutionResult {
  sessionId: string;
  turnId?: string;
  terminalStatus: TurnStatus;
  accumulatedText: string;
  eventsCount: number;
  lastEventId?: string;
  unsupportedEvents: string[];
  error?: string;
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
   * Dispatches a user message to TrueForge and consumes the Server-Sent Events stream incrementally.
   */
  public async executeTurn(
    config: TrueForgeResolvedConfig,
    sessionId: string,
    message: string,
    options?: { abortSignal?: AbortSignal }
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

    // Set up local AbortController for client-side stream termination
    const localAbortController = new AbortController();
    this.state.setActiveAbortController(localAbortController);

    // If external abortSignal provided, chain it
    if (options?.abortSignal) {
      options.abortSignal.addEventListener("abort", () => {
        localAbortController.abort();
      });
    }

    this.state.setActiveTurn(undefined, "RUNNING");
    this.logger.info(`--- Starting Turn in Session: ${sessionId} ---`);
    this.logger.info(`User Input: "${message.trim()}"`);

    const client = this.clientFactory.createClient(config);
    const result: TurnExecutionResult = {
      sessionId,
      terminalStatus: "RUNNING",
      accumulatedText: "",
      eventsCount: 0,
      unsupportedEvents: [],
    };

    let hasStreamedDeltas = false;

    try {
      const stream = await client.sessions.createTurnStream(
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

      this.logger.info("SSE turn stream connection established. Receiving events...");

      for await (const rawEvent of stream) {
        result.eventsCount++;
        const classified = classifyTurnEvent(rawEvent);

        if (classified.id) {
          result.lastEventId = classified.id;
          this.state.setLastEventId(classified.id);
        }

        switch (classified.type) {
          case "turn.created": {
            if (classified.turnId) {
              result.turnId = classified.turnId;
              this.state.setActiveTurn(classified.turnId, "RUNNING");
              this.logger.info(`[EVENT: turn.created] Active Turn ID: ${classified.turnId}`);
            }
            break;
          }

          case "model.message.delta": {
            if (classified.deltaText) {
              hasStreamedDeltas = true;
              this.state.appendTurnText(classified.deltaText);
              result.accumulatedText += classified.deltaText;
              this.logger.streamChunk(classified.deltaText);
            }
            break;
          }

          case "model.message": {
            // Only output messageText if no deltas were streamed for this message to prevent duplicate text
            if (!hasStreamedDeltas && classified.messageText) {
              this.state.appendTurnText(classified.messageText);
              result.accumulatedText += classified.messageText;
              this.logger.info(`[EVENT: model.message] ${classified.messageText}`);
            }
            break;
          }

          case "turn.update": {
            this.logger.debug(`[EVENT: turn.update] State updated.`);
            break;
          }

          case "tool.approval_required":
          case "tool.response_required":
          case "mcp.auth_required": {
            result.unsupportedEvents.push(classified.type);
            this.logger.warn(`[UNSUPPORTED IN MILESTONE 0] ${classified.unsupportedReason}`);
            this.state.setTurnStatus("PAUSED");
            result.terminalStatus = "PAUSED";
            break;
          }

          case "turn.done": {
            this.logger.streamChunk("\n"); // Flush output line
            const termStatus = classified.terminalStatus || "done";
            if (termStatus === "cancelled") {
              this.state.setTurnStatus("CANCELLED");
              result.terminalStatus = "CANCELLED";
            } else if (termStatus === "error") {
              this.state.setTurnStatus("ERROR");
              result.terminalStatus = "ERROR";
            } else {
              this.state.setTurnStatus("COMPLETED");
              result.terminalStatus = "COMPLETED";
            }
            this.logger.info(
              `[EVENT: turn.done] Terminal Status: ${termStatus}` +
                (classified.terminalReason ? ` (Reason: ${classified.terminalReason})` : "")
            );
            break;
          }

          default: {
            if (classified.isUnsupportedInM0) {
              result.unsupportedEvents.push(classified.type);
              this.logger.warn(`[UNSUPPORTED IN MILESTONE 0] ${classified.unsupportedReason}`);
            }
            break;
          }
        }
      }

      // If turnId is known, verify authoritative server state
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
          } else if (serverStatus === "done") {
            result.terminalStatus = "COMPLETED";
            this.state.setTurnStatus("COMPLETED");
          }
        } catch (authErr: unknown) {
          this.logger.warn(
            `Could not query authoritative turn status: ${authErr instanceof Error ? authErr.message : String(authErr)}`
          );
        }
      }

      return result;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isAbort = (err as Error)?.name === "AbortError" || errMsg.includes("abort");

      if (isAbort) {
        this.logger.warn(`Client turn stream aborted locally.`);
        this.state.setTurnStatus("CANCELLED");
        result.terminalStatus = "CANCELLED";
        result.error = "Turn stream cancelled by client.";
        return result;
      }

      this.logger.error(`Turn stream encountered an error: ${errMsg}`, err);
      this.state.setTurnStatus("ERROR");
      result.terminalStatus = "ERROR";
      result.error = errMsg;
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

    // 1. Retrieve authoritative turn state from server
    let serverStatus: string | undefined;
    try {
      const turnResp = await client.sessions.getTurn(sessionId, turnId);
      serverStatus = turnResp.data.state?.status;
      this.logger.info(`Retrieved authoritative turn status: ${serverStatus}`);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to retrieve authoritative turn state: ${errMsg}`, err);
      throw new TrueForgeStreamError(`Cannot recover turn: ${errMsg}`, sessionId, turnId);
    }

    const result: TurnExecutionResult = {
      sessionId,
      turnId,
      terminalStatus: "RUNNING",
      accumulatedText: this.state.turnAccumulatedText,
      eventsCount: 0,
      unsupportedEvents: [],
    };

    // If already terminal, return state without re-executing
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
      this.logger.warn(`Turn ${turnId} is currently paused awaiting interaction (unsupported in Milestone 0).`);
      return result;
    }

    // Turn is still running: reconnect using subscribeToTurn with fromEventId cursor
    this.logger.info(`Turn ${turnId} is still running. Subscribing to stream fromEventId: ${lastEventId || "tip"}...`);
    try {
      const subscribeStream = await client.sessions.subscribeToTurn(
        sessionId,
        turnId,
        lastEventId ? { fromEventId: lastEventId } : {}
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
      const subErrMsg = subErr instanceof Error ? subErr.message : String(subErr);
      this.logger.error(`Reconnection subscription error: ${subErrMsg}`, subErr);
      throw new TrueForgeStreamError(`Subscription recovery failed: ${subErrMsg}`, sessionId, turnId, lastEventId);
    }
  }
}
