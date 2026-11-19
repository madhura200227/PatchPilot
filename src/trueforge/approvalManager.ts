import { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { TrueForgeResolvedConfig } from "../config/configuration";
import { ILogger } from "../output/logger";
import { ITrueForgeClientFactory } from "./clientFactory";

/**
 * PatchPilot TrueForge Interactive Tool Approval Manager
 *
 * Tracks genuine TrueForge tool.approval_required events, exposes them to the UI for
 * explicit human allow/deny decisions, and submits user.tool_approval events back to
 * TrueForge via client.sessions.createTurnEvents().
 */

export type ApprovalStatus = "pending" | "approved" | "denied";

export interface PendingToolApproval {
  sessionId: string;
  turnId: string;
  threadId: string;
  toolCallId: string;
  sourceEventId: string;
  toolName: string;
  argumentsRaw: string;
  parsedArguments?: Record<string, unknown>;
  status: ApprovalStatus;
  reason?: string;
  createdAt: string;
}

interface DeferredDecision {
  resolve: (decision: { allow: boolean; reason?: string }) => void;
  reject: (err: Error) => void;
}

export class ApprovalManager {
  private readonly approvals = new Map<string, PendingToolApproval>();
  private readonly waiters = new Map<string, DeferredDecision>();
  private readonly listeners: Array<(approvals: PendingToolApproval[]) => void> = [];

  constructor(
    private readonly clientFactory: ITrueForgeClientFactory,
    private readonly logger: ILogger
  ) {}

  public onDidChange(listener: (approvals: PendingToolApproval[]) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) {
        this.listeners.splice(idx, 1);
      }
    };
  }

  private notify(): void {
    const snapshot = this.getPendingApprovals();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Ignore listener failure
      }
    }
  }

  public getPendingApprovals(): PendingToolApproval[] {
    return Array.from(this.approvals.values()).filter((a) => a.status === "pending");
  }

  public getAllApprovals(): PendingToolApproval[] {
    return Array.from(this.approvals.values());
  }

  /**
   * Registers a pending tool approval from TrueForge and returns a promise resolved when the user decides.
   */
  public registerPendingApproval(
    approval: Omit<PendingToolApproval, "status" | "createdAt">
  ): Promise<{ allow: boolean; reason?: string }> {
    const record: PendingToolApproval = {
      ...approval,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.approvals.set(approval.toolCallId, record);
    this.logger.info(
      `[APPROVAL REQUIRED] Tool "${approval.toolName}" (callId=${approval.toolCallId}) awaits human approval.`
    );
    this.notify();

    return new Promise<{ allow: boolean; reason?: string }>((resolve, reject) => {
      this.waiters.set(approval.toolCallId, { resolve, reject });
    });
  }

  /**
   * Submits the human user's allow or deny decision to TrueForge via sessions.createTurnEvents.
   */
  public async submitDecision(
    config: TrueForgeResolvedConfig,
    toolCallId: string,
    allow: boolean,
    reason?: string
  ): Promise<PendingToolApproval> {
    const record = this.approvals.get(toolCallId);
    if (!record) {
      throw new Error(`No pending tool approval found for toolCallId "${toolCallId}".`);
    }
    if (record.status !== "pending") {
      return record;
    }

    const decision: TrueForgeApi.ApprovalDecision = allow
      ? { status: "allow" }
      : { status: "deny", reason: reason || "Denied by user in PatchPilot review UI." };

    const client = this.clientFactory.createClient(config);
    this.logger.info(
      `Submitting TrueForge user.tool_approval for "${record.toolName}" (${toolCallId}): ${decision.status}`
    );

    await client.sessions.createTurnEvents(record.sessionId, record.turnId, {
      events: [
        {
          type: "user.tool_approval",
          threadId: record.threadId,
          toolCallId: record.toolCallId,
          approval: decision,
        },
      ],
    });

    record.status = allow ? "approved" : "denied";
    record.reason = reason;
    this.notify();

    const waiter = this.waiters.get(toolCallId);
    if (waiter) {
      this.waiters.delete(toolCallId);
      waiter.resolve({ allow, reason });
    }

    return record;
  }

  /**
   * Cancels all unresolved pending approvals (e.g. when user cancels the active turn).
   */
  public cancelAllPending(reason: string = "Turn cancelled by user"): void {
    let changed = false;
    for (const [toolCallId, record] of this.approvals.entries()) {
      if (record.status === "pending") {
        record.status = "denied";
        record.reason = reason;
        changed = true;
      }
      const waiter = this.waiters.get(toolCallId);
      if (waiter) {
        this.waiters.delete(toolCallId);
        waiter.reject(new Error(reason));
      }
    }
    if (changed) {
      this.notify();
    }
  }

  public clearHistory(): void {
    this.cancelAllPending("Approval history cleared");
    this.approvals.clear();
    this.notify();
  }
}
