import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  MAX_FILE_SIZE_BYTES,
  resolveCanonicalWorkspaceRoot,
  resolveSafeWorkspacePath,
  safeReadWorkspaceTextFile,
  SecurityError,
} from "../security/pathGuard";
import {
  computeSha256,
  detectSelectionExpansion,
  DiffHunk,
  formatUnifiedDiff,
  generateDiffHunks,
  HunkDecision,
  SelectionExpansionReport,
} from "./patchEngine";

/**
 * PatchPilot Isolated Proposal Store
 *
 * Stores all agent-proposed file edits in an isolated temporary directory outside the user's
 * workspace working tree. Never writes to the user's workspace.
 */

export type ProposalStatus = "pending" | "partially_applied" | "applied" | "discarded" | "stale";

export interface InlineSelectionConstraint {
  relativePath: string;
  startLine: number;
  endLine: number;
}

export interface FileProposal {
  proposalId: string;
  runId: string;
  relativePath: string;
  isNewFile: boolean;
  originalSha256: string | null;
  proposedSha256: string;
  originalContent: string;
  proposedContent: string;
  summary: string;
  hunks: DiffHunk[];
  status: ProposalStatus;
  staleReason?: string;
  createdAt: string;
  updatedAt: string;
  selectionExpansion?: SelectionExpansionReport;
}

interface PersistedStorePayload {
  workspaceRoot: string;
  proposals: FileProposal[];
  cancelledRunIds: string[];
  activeRunId: string | null;
  selectionConstraint: InlineSelectionConstraint | null;
}

export interface CreateProposalInput {
  relativePath: string;
  proposedContent: string;
  summary?: string;
  runId?: string;
}

export interface ProposalCreationResult {
  proposal: FileProposal;
  unifiedDiff: string;
  addedLines: number;
  removedLines: number;
}

export class ProposalStore {
  private readonly storeDir: string;
  private readonly storeFile: string;
  private readonly workspaceRoot: string;

  constructor(workspaceRoot: string, storeDir?: string) {
    this.workspaceRoot = resolveCanonicalWorkspaceRoot(workspaceRoot);
    this.storeDir =
      storeDir ??
      path.join(
        os.tmpdir(),
        "patchpilot-proposals",
        crypto.createHash("sha256").update(this.workspaceRoot).digest("hex").slice(0, 12) +
          "-" +
          crypto.randomBytes(4).toString("hex")
      );
    fs.mkdirSync(this.storeDir, { recursive: true });
    this.storeFile = path.join(this.storeDir, "proposals.json");

    if (!fs.existsSync(this.storeFile)) {
      this.savePayload({
        workspaceRoot: this.workspaceRoot,
        proposals: [],
        cancelledRunIds: [],
        activeRunId: null,
        selectionConstraint: null,
      });
    }
  }

  public getStoreDir(): string {
    return this.storeDir;
  }

  public getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  private loadPayload(): PersistedStorePayload {
    if (!fs.existsSync(this.storeFile)) {
      return {
        workspaceRoot: this.workspaceRoot,
        proposals: [],
        cancelledRunIds: [],
        activeRunId: null,
        selectionConstraint: null,
      };
    }
    const raw = fs.readFileSync(this.storeFile, "utf8");
    return JSON.parse(raw) as PersistedStorePayload;
  }

  private savePayload(payload: PersistedStorePayload): void {
    fs.mkdirSync(this.storeDir, { recursive: true });
    const tmpFile = `${this.storeFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(tmpFile, this.storeFile);
  }

  public setActiveRun(runId: string | null, selectionConstraint?: InlineSelectionConstraint | null): void {
    const payload = this.loadPayload();
    payload.activeRunId = runId;
    if (selectionConstraint !== undefined) {
      payload.selectionConstraint = selectionConstraint;
    }
    this.savePayload(payload);
  }

  public getActiveRunId(): string | null {
    return this.loadPayload().activeRunId;
  }

  public markRunCancelled(runId: string): number {
    const payload = this.loadPayload();
    if (!payload.cancelledRunIds.includes(runId)) {
      payload.cancelledRunIds.push(runId);
    }
    let discarded = 0;
    for (const p of payload.proposals) {
      if (p.runId === runId && p.status === "pending") {
        p.status = "discarded";
        p.updatedAt = new Date().toISOString();
        discarded++;
      }
    }
    if (payload.activeRunId === runId) {
      payload.activeRunId = null;
      payload.selectionConstraint = null;
    }
    this.savePayload(payload);
    return discarded;
  }

  public isRunCancelled(runId: string): boolean {
    const payload = this.loadPayload();
    return payload.cancelledRunIds.includes(runId);
  }

  /**
   * Creates or updates a file change proposal strictly in isolated proposal storage.
   * NEVER writes to the actual workspace.
   */
  public async createOrUpdateProposal(input: CreateProposalInput): Promise<ProposalCreationResult> {
    if (typeof input.proposedContent !== "string") {
      throw new SecurityError("Proposed content must be a UTF-8 string.");
    }

    const byteLength = Buffer.byteLength(input.proposedContent, "utf8");
    if (byteLength > MAX_FILE_SIZE_BYTES) {
      throw new SecurityError(
        `Proposed file content (${byteLength} bytes) exceeds maximum limit of ${MAX_FILE_SIZE_BYTES} bytes.`
      );
    }

    const payload = this.loadPayload();
    const runId = input.runId ?? payload.activeRunId ?? "default-run";
    if (payload.cancelledRunIds.includes(runId)) {
      throw new SecurityError(
        `Run "${runId}" was cancelled; no further proposals may be created for this run.`
      );
    }

    // Validate target path safely inside workspace boundary (rejecting symlinks & protected files)
    const safeTarget = resolveSafeWorkspacePath(this.workspaceRoot, input.relativePath, {
      checkExtension: true,
      mustExist: false,
      allowDirectory: false,
      rejectSymlinks: true,
    });
    const relativePath = path.relative(this.workspaceRoot, safeTarget).replace(/\\/g, "/");

    let isNewFile = false;
    let originalContent = "";
    let originalSha256: string | null = null;

    if (fs.existsSync(safeTarget)) {
      const existing = await safeReadWorkspaceTextFile(this.workspaceRoot, relativePath);
      originalContent = existing.content;
      originalSha256 = existing.sha256;
    } else {
      isNewFile = true;
    }

    const proposedSha256 = computeSha256(input.proposedContent);
    const hunks = generateDiffHunks(originalContent, input.proposedContent, 3);

    if (hunks.length === 0 && !isNewFile) {
      throw new Error(`Proposed content for "${relativePath}" has no line differences from the current file.`);
    }

    let selectionExpansion: SelectionExpansionReport | undefined;
    if (
      !isNewFile &&
      payload.selectionConstraint &&
      payload.selectionConstraint.relativePath.replace(/\\/g, "/").toLowerCase() ===
        relativePath.toLowerCase()
    ) {
      selectionExpansion = detectSelectionExpansion(
        originalContent,
        input.proposedContent,
        payload.selectionConstraint.startLine,
        payload.selectionConstraint.endLine
      );
    }

    const now = new Date().toISOString();
    const existingIdx = payload.proposals.findIndex(
      (p) =>
        p.relativePath.toLowerCase() === relativePath.toLowerCase() &&
        (p.status === "pending" || p.status === "partially_applied")
    );

    const proposal: FileProposal = {
      proposalId:
        existingIdx >= 0
          ? payload.proposals[existingIdx].proposalId
          : `prop-${crypto.randomBytes(6).toString("hex")}`,
      runId,
      relativePath,
      isNewFile,
      originalSha256,
      proposedSha256,
      originalContent,
      proposedContent: input.proposedContent,
      summary:
        input.summary?.trim() ||
        (isNewFile ? `Create new file ${relativePath}` : `Modify ${relativePath}`),
      hunks,
      status: "pending",
      createdAt: existingIdx >= 0 ? payload.proposals[existingIdx].createdAt : now,
      updatedAt: now,
      selectionExpansion,
    };

    if (existingIdx >= 0) {
      payload.proposals[existingIdx] = proposal;
    } else {
      payload.proposals.push(proposal);
    }

    this.savePayload(payload);

    const addedLines = hunks.reduce((sum, h) => sum + h.addedCount, 0);
    const removedLines = hunks.reduce((sum, h) => sum + h.removedCount, 0);

    return {
      proposal,
      unifiedDiff: formatUnifiedDiff(relativePath, hunks),
      addedLines,
      removedLines,
    };
  }

  public listProposals(options: { includeClosed?: boolean } = {}): FileProposal[] {
    const payload = this.loadPayload();
    if (options.includeClosed) {
      return payload.proposals;
    }
    return payload.proposals.filter(
      (p) => p.status === "pending" || p.status === "partially_applied" || p.status === "stale"
    );
  }

  public getProposal(proposalId: string): FileProposal | undefined {
    return this.loadPayload().proposals.find((p) => p.proposalId === proposalId);
  }

  public setHunkDecision(proposalId: string, hunkId: string, decision: HunkDecision): FileProposal {
    const payload = this.loadPayload();
    const proposal = payload.proposals.find((p) => p.proposalId === proposalId);
    if (!proposal) {
      throw new Error(`Proposal "${proposalId}" not found.`);
    }
    const hunk = proposal.hunks.find((h) => h.id === hunkId);
    if (!hunk) {
      throw new Error(`Hunk "${hunkId}" not found in proposal "${proposalId}".`);
    }
    hunk.decision = decision;
    proposal.updatedAt = new Date().toISOString();
    this.savePayload(payload);
    return proposal;
  }

  public setAllHunksDecision(proposalId: string, decision: HunkDecision): FileProposal {
    const payload = this.loadPayload();
    const proposal = payload.proposals.find((p) => p.proposalId === proposalId);
    if (!proposal) {
      throw new Error(`Proposal "${proposalId}" not found.`);
    }
    for (const h of proposal.hunks) {
      h.decision = decision;
    }
    proposal.updatedAt = new Date().toISOString();
    this.savePayload(payload);
    return proposal;
  }

  public markProposalStatus(proposalId: string, status: ProposalStatus, staleReason?: string): void {
    const payload = this.loadPayload();
    const proposal = payload.proposals.find((p) => p.proposalId === proposalId);
    if (!proposal) {
      return;
    }
    proposal.status = status;
    proposal.staleReason = staleReason;
    proposal.updatedAt = new Date().toISOString();
    this.savePayload(payload);
  }

  public discardAllPending(): number {
    const payload = this.loadPayload();
    let count = 0;
    for (const p of payload.proposals) {
      if (p.status === "pending" || p.status === "partially_applied" || p.status === "stale") {
        p.status = "discarded";
        p.updatedAt = new Date().toISOString();
        count++;
      }
    }
    this.savePayload(payload);
    return count;
  }

  public cleanup(): void {
    try {
      fs.rmSync(this.storeDir, { recursive: true, force: true });
    } catch {
      // Best-effort temp cleanup
    }
  }
}
