import { TrueForge } from "@truefoundry/trueforge-sdk";
import { TrueForgeResolvedConfig } from "../config/configuration";
import { ExtensionState, TurnStatus } from "../state/extensionState";
import { ILogger } from "../output/logger";
import { ITrueForgeClientFactory } from "./clientFactory";
import { TrueForgeCancellationError } from "./errors";

export interface CancellationResult {
  sessionId: string;
  turnId?: string;
  clientAborted: boolean;
  serverAccepted: boolean;
  authoritativeStatus?: TurnStatus | string;
  message: string;
}

export class CancellationManager {
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
   * Performs coordinated cancellation across Layer A (client stream abort) and Layer B (server turn cancel).
   */
  public async cancelActiveTurn(config: TrueForgeResolvedConfig): Promise<CancellationResult> {
    const sessionId = this.state.activeSessionId;
    const turnId = this.state.activeTurnId;

    if (!sessionId) {
      this.logger.warn("Cannot cancel: no active session found.");
      return {
        sessionId: "",
        clientAborted: false,
        serverAccepted: false,
        message: "No active session to cancel.",
      };
    }

    // Guard against duplicate/concurrent cancellation dispatches
    if (!this.state.acquireCancelGuard()) {
      this.logger.debug("Cancellation already in progress.");
      return {
        sessionId,
        turnId,
        clientAborted: false,
        serverAccepted: false,
        message: "Cancellation is already in progress.",
      };
    }

    const result: CancellationResult = {
      sessionId,
      turnId,
      clientAborted: false,
      serverAccepted: false,
      message: "",
    };

    try {
      this.logger.info(`--- Initiating Cancellation for Session: ${sessionId} ---`);

      // 1. Layer A: Local Client Stream Abort
      const activeAbort = this.state.activeAbortController;
      if (activeAbort && !activeAbort.signal.aborted) {
        try {
          activeAbort.abort();
          result.clientAborted = true;
          this.logger.info("[Layer A] Client AbortController signal fired.");
        } catch (abortErr: unknown) {
          this.logger.warn(`Client abort error: ${abortErr instanceof Error ? abortErr.message : String(abortErr)}`);
        }
      } else {
        this.logger.debug("[Layer A] No active stream controller to abort or already aborted.");
      }

      // 2. Layer B: Authoritative Server-Side Turn Cancellation
      const client = this.clientFactory.createClient(config);
      try {
        this.logger.info(`[Layer B] Requesting server-side cancellation (POST /api/v1/sessions/${sessionId}/cancel)...`);
        await client.sessions.cancel(sessionId);
        result.serverAccepted = true;
        this.logger.info("[Layer B] Server accepted turn cancellation request.");
      } catch (serverErr: unknown) {
        const errMsg = serverErr instanceof Error ? serverErr.message : String(serverErr);

        // Precondition failed (412) typically indicates the turn already finished or no turn was running
        if (
          errMsg.includes("PreconditionFailed") ||
          errMsg.includes("412") ||
          errMsg.includes("no running turn") ||
          errMsg.includes("not running")
        ) {
          result.serverAccepted = true; // Endpoint responded functionally: turn is already idle/completed
          this.logger.info(`[Layer B] Server indicated turn is not in a cancellable running state: ${errMsg}`);
        } else {
          this.logger.error(`[Layer B] Server cancellation request failed: ${errMsg}`, serverErr);
          result.message = `Server cancellation failed: ${errMsg}`;
        }
      }

      // 3. Verify Authoritative Turn State if turnId exists
      if (turnId) {
        try {
          const authTurn = await client.sessions.getTurn(sessionId, turnId);
          const serverState = authTurn.data.state?.status;
          result.authoritativeStatus = serverState;
          this.logger.info(`Authoritative post-cancel turn state: ${serverState}`);

          if (serverState === "cancelled") {
            this.state.setTurnStatus("CANCELLED");
          } else if (serverState === "done") {
            this.state.setTurnStatus("COMPLETED");
            this.logger.info("Turn completed before cancellation could take effect.");
          } else if (serverState === "error") {
            this.state.setTurnStatus("ERROR");
          }
        } catch (getTurnErr: unknown) {
          this.logger.warn(
            `Could not query authoritative turn status post-cancel: ${getTurnErr instanceof Error ? getTurnErr.message : String(getTurnErr)}`
          );
        }
      } else {
        this.state.setTurnStatus("CANCELLED");
      }

      result.message = "Turn cancellation completed.";
      return result;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Cancellation error: ${errMsg}`, err);
      throw new TrueForgeCancellationError(`Cancellation failed: ${errMsg}`, sessionId, turnId);
    } finally {
      this.state.releaseCancelGuard();
    }
  }
}
