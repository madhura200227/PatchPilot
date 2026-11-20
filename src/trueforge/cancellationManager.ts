import { TrueForgeResolvedConfig } from "../config/configuration";
import { ILogger } from "../output/logger";
import { sanitizeSecretText } from "../security/secretFilter";
import { ExtensionState, TurnStatus } from "../state/extensionState";
import { ApprovalManager } from "./approvalManager";
import { ITrueForgeClientFactory } from "./clientFactory";
import { TrueForgeCancellationError } from "./errors";

export interface CancellationResult {
  sessionId: string;
  turnId?: string;
  clientAborted: boolean;
  serverAccepted: boolean;
  authoritativeStatus?: TurnStatus | string;
  abortedLocalCommands: number;
  discardedProposals: number;
  message: string;
}

export interface CancelHookOptions {
  runId?: string;
  approvalManager?: ApprovalManager;
  cancelLocalMcp?: (runId?: string) => Promise<{ abortedCommands: number; discardedProposals: number }>;
  pollAttempts?: number;
  pollIntervalMs?: number;
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
   * Coordinates safe multi-layer cancellation:
   * 1. Requests authoritative TrueForge server-side turn cancellation (POST /sessions/:id/cancel).
   * 2. Cancels pending local approvals and active local MCP subprocesses + unaccepted proposals.
   * 3. Polls authoritative server turn state via getTurn() until terminal status is confirmed.
   * 4. Aborts the local client SSE stream controller cleanly.
   */
  public async cancelActiveTurn(
    config: TrueForgeResolvedConfig,
    hooks?: CancelHookOptions
  ): Promise<CancellationResult> {
    const sessionId = this.state.activeSessionId;
    const turnId = this.state.activeTurnId;

    if (!sessionId) {
      // Still clean up any stray local MCP processes if hooks were provided
      let abortedLocalCommands = 0;
      let discardedProposals = 0;
      if (hooks?.cancelLocalMcp) {
        const local = await hooks.cancelLocalMcp(hooks.runId);
        abortedLocalCommands = local.abortedCommands;
        discardedProposals = local.discardedProposals;
      }
      this.logger.warn("Cannot cancel: no active session found.");
      return {
        sessionId: "",
        clientAborted: false,
        serverAccepted: false,
        abortedLocalCommands,
        discardedProposals,
        message: "No active session to cancel.",
      };
    }

    if (!this.state.acquireCancelGuard()) {
      this.logger.debug("Cancellation already in progress.");
      return {
        sessionId,
        turnId,
        clientAborted: false,
        serverAccepted: false,
        abortedLocalCommands: 0,
        discardedProposals: 0,
        message: "Cancellation is already in progress.",
      };
    }

    const result: CancellationResult = {
      sessionId,
      turnId,
      clientAborted: false,
      serverAccepted: false,
      abortedLocalCommands: 0,
      discardedProposals: 0,
      message: "",
    };

    const activeAbort = this.state.activeAbortController;

    try {
      this.logger.info(`--- Initiating Cancellation for Session: ${sessionId} ---`);

      // 1. Server-side cancellation FIRST (authoritative TrueForge turn cancel)
      const client = this.clientFactory.createClient(config);
      try {
        this.logger.info(
          `[Layer B] Requesting server-side cancellation (POST /api/v1/sessions/${sessionId}/cancel)...`
        );
        await client.sessions.cancel(sessionId);
        result.serverAccepted = true;
        this.logger.info("[Layer B] Server accepted turn cancellation request.");
      } catch (serverErr: unknown) {
        const errMsg = sanitizeSecretText(
          serverErr instanceof Error ? serverErr.message : String(serverErr)
        );
        if (
          errMsg.includes("PreconditionFailed") ||
          errMsg.includes("412") ||
          errMsg.includes("no running turn") ||
          errMsg.includes("not running")
        ) {
          result.serverAccepted = true;
          this.logger.info(
            `[Layer B] Server indicated turn is not in a cancellable running state: ${errMsg}`
          );
        } else {
          this.logger.error(`[Layer B] Server cancellation request failed: ${errMsg}`);
          result.message = `Server cancellation failed: ${errMsg}`;
        }
      }

      // 2. Abort any pending approval UI prompts & active local MCP command subprocesses / proposals
      hooks?.approvalManager?.cancelAllPending("Turn cancelled by user");
      if (hooks?.cancelLocalMcp) {
        try {
          const localRes = await hooks.cancelLocalMcp(hooks.runId);
          result.abortedLocalCommands = localRes.abortedCommands;
          result.discardedProposals = localRes.discardedProposals;
          this.logger.info(
            `[Layer C] Local MCP cleanup: aborted ${localRes.abortedCommands} command(s), discarded ${localRes.discardedProposals} pending proposal(s).`
          );
        } catch (localErr: unknown) {
          this.logger.warn(
            `[Layer C] Local MCP cleanup warning: ${sanitizeSecretText(localErr instanceof Error ? localErr.message : String(localErr))}`
          );
        }
      }

      // 3. Query authoritative server turn state (polling briefly while transitioning to terminal state)
      if (turnId) {
        const maxPolls = hooks?.pollAttempts ?? 5;
        const pollIntervalMs = hooks?.pollIntervalMs ?? 200;

        for (let attempt = 0; attempt < maxPolls; attempt++) {
          try {
            const authTurn = await client.sessions.getTurn(sessionId, turnId);
            const serverState = authTurn.data.state?.status;
            result.authoritativeStatus = serverState;

            if (serverState === "cancelled") {
              this.state.setTurnStatus("CANCELLED");
              this.logger.info("Authoritative post-cancel turn state confirmed: cancelled");
              break;
            } else if (serverState === "done") {
              this.state.setTurnStatus("COMPLETED");
              this.logger.info("Turn completed before cancellation could take effect.");
              break;
            } else if (serverState === "error") {
              this.state.setTurnStatus("ERROR");
              this.logger.info("Authoritative post-cancel turn state: error");
              break;
            }

            if (attempt < maxPolls - 1) {
              await new Promise((r) => setTimeout(r, pollIntervalMs));
            }
          } catch (getTurnErr: unknown) {
            this.logger.warn(
              `Could not query authoritative turn status post-cancel: ${sanitizeSecretText(getTurnErr instanceof Error ? getTurnErr.message : String(getTurnErr))}`
            );
            break;
          }
        }
      } else {
        this.state.setTurnStatus("CANCELLED");
      }

      // 4. Client SSE stream abort (clean teardown of any lingering HTTP stream reader)
      if (activeAbort && !activeAbort.signal.aborted) {
        try {
          activeAbort.abort();
          result.clientAborted = true;
          this.logger.info("[Layer A] Client AbortController signal fired.");
        } catch (abortErr: unknown) {
          this.logger.warn(
            `Client abort error: ${abortErr instanceof Error ? abortErr.message : String(abortErr)}`
          );
        }
      } else {
        this.logger.debug("[Layer A] No active stream controller to abort or already aborted.");
      }

      result.message =
        result.message ||
        `Turn cancellation processed (authoritative status: ${result.authoritativeStatus || "cancelled"}, discarded ${result.discardedProposals} unaccepted proposal(s)).`;
      return result;
    } catch (err: unknown) {
      const errMsg = sanitizeSecretText(err instanceof Error ? err.message : String(err));
      this.logger.error(`Cancellation error: ${errMsg}`);
      throw new TrueForgeCancellationError(`Cancellation failed: ${errMsg}`, sessionId, turnId);
    } finally {
      this.state.releaseCancelGuard();
    }
  }
}
