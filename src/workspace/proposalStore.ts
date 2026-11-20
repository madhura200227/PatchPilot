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
import {
  applyRangeReplacement,
  EditMode,
  InlineEditContext,
  RangeEditValidationError,
  ZeroBasedRange,
} from "./rangeEdit";

/**
 * PatchPilot Isolated Proposal Store
 *
 * Stores all agent-proposed file edits in an isolated temporary directory outside the user's
 * workspace working tree. Never writes to the user's workspace.
 *
 * Enforces explicit edit modes ("range" vs "full_file") so inline-edit selections can never
 * be misapplied as destructive full-file replacements.
 */

export type ProposalStatus = "pending" | "partially_applied" | "applied" | "discarded" | "stale";

/** Legacy line-only selection constraint preserved for compatibility */
export interface InlineSelectionConstraint {
  relativePath: string;
  startLine: number;
  endLine: number;
}

export interface FileProposal {
  proposalId: string;
  runId: string;
  relativePath: string;
  editMode: EditMode;
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
  selectionRange?: ZeroBasedRange;
  prefixPreserved?: boolean;
  suffixPreserved?: boolean;
  selectionExpansion?: SelectionExpansionReport & { explicitlyRequested?: boolean };
}

interface PersistedStorePayload {
  workspaceRoot: string;
  proposals: FileProposal[];
  cancelledRunIds: string[];
  activeRunId: string | null;
  selectionConstraint: InlineSelectionConstraint | null;
  inlineEditContext: InlineEditContext | null;
}

export interface CreateProposalInput {
  relativePath: string;
  /** Explicit edit mode: "range" for inline-edit replacement, "full_file" for Agent Mode full file */
  mode?: EditMode;
  /** Replacement text for the selected (or expanded) range when mode === "range" */
  replacement?: string;
  /** Complete UTF-8 file content when mode === "full_file" (legacy alias for content) */
  proposedContent?: string;
  /** Complete UTF-8 file content when mode === "full_file" */
  content?: string;
  /** Optional explicit InlineEditContext (if omitted, uses the active run's stored context) */
  inlineEditContext?: InlineEditContext;
  /** Optional explicit 0-based expanded range (requires expansionReason) */
  expandedRange?: ZeroBasedRange;
  /** Required explanation whenever expandedRange is provided */
  expansionReason?: string;
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
        inlineEditContext: null,
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
        inlineEditContext: null,
      };
    }
    const raw = fs.readFileSync(this.storeFile, "utf8");
    const parsed = JSON.parse(raw) as PersistedStorePayload;
    if (parsed.inlineEditContext === undefined) {
      parsed.inlineEditContext = null;
    }
    return parsed;
  }

  private savePayload(payload: PersistedStorePayload): void {
    fs.mkdirSync(this.storeDir, { recursive: true });
    const tmpFile = `${this.storeFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(tmpFile, this.storeFile);
  }

  public setActiveRun(
    runId: string | null,
    selectionConstraint?: InlineSelectionConstraint | null,
    inlineEditContext?: InlineEditContext | null
  ): void {
    const payload = this.loadPayload();
    payload.activeRunId = runId;
    if (selectionConstraint !== undefined) {
      payload.selectionConstraint = selectionConstraint;
    }
    if (inlineEditContext !== undefined) {
      payload.inlineEditContext = inlineEditContext;
      if (inlineEditContext && selectionConstraint === undefined) {
        payload.selectionConstraint = {
          relativePath: inlineEditContext.relativePath,
          startLine: inlineEditContext.displayStartLine,
          endLine: inlineEditContext.displayEndLine,
        };
      }
    }
    if (runId === null && inlineEditContext === undefined) {
      payload.inlineEditContext = null;
    }
    this.savePayload(payload);
  }

  public getActiveRunId(): string | null {
    return this.loadPayload().activeRunId;
  }

  public getActiveInlineEditContext(): InlineEditContext | null {
    return this.loadPayload().inlineEditContext;
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
      payload.inlineEditContext = null;
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
   * Enforces explicit edit modes ("range" vs "full_file") and NEVER writes to the workspace.
   */
  public async createOrUpdateProposal(input: CreateProposalInput): Promise<ProposalCreationResult> {
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

    const activeInlineCtx =
      input.inlineEditContext ??
      (payload.inlineEditContext &&
      payload.inlineEditContext.relativePath.replace(/\\/g, "/").toLowerCase() ===
        relativePath.toLowerCase()
        ? payload.inlineEditContext
        : null);

    // Determine explicit edit mode — NEVER infer edit mode from string length!
    const editMode: EditMode = input.mode ?? "full_file";

    // HARD GUARD: During an active inline edit for this file, reject full-file replacement mode
    // so an incomplete or fragmented model response can NEVER destroy unselected code.
    if (activeInlineCtx && editMode === "full_file") {
      throw new RangeEditValidationError(
        "FULL_FILE_REJECTED_IN_INLINE_EDIT",
        `An inline-edit session is active for "${relativePath}" (lines ${activeInlineCtx.displayStartLine}-${activeInlineCtx.displayEndLine}). ` +
          `Full-file replacement is blocked during inline edit to guarantee unselected code is preserved. ` +
          `Call propose_edit with mode="range" and replacement containing ONLY the updated text for the selected range ` +
          `(or also provide expandedRange and expansionReason if lines outside the selection genuinely must change).`
      );
    }

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

    let finalProposedContent: string;
    let selectionRange: ZeroBasedRange | undefined;
    let prefixPreserved: boolean | undefined;
    let suffixPreserved: boolean | undefined;
    let selectionExpansion:
      | (SelectionExpansionReport & { explicitlyRequested?: boolean })
      | undefined;

    if (editMode === "range") {
      if (isNewFile) {
        throw new RangeEditValidationError(
          "INVALID_RANGE",
          `Cannot apply mode="range" to non-existent file "${relativePath}". Use mode="full_file" to create a new file.`
        );
      }
      if (!activeInlineCtx) {
        throw new RangeEditValidationError(
          "INVALID_RANGE",
          `No active inline-edit selection context is registered for "${relativePath}". Start an inline edit first or use mode="full_file" in Agent Mode.`
        );
      }
      if (typeof input.replacement !== "string") {
        throw new RangeEditValidationError(
          "MALFORMED_REPLACEMENT",
          'mode="range" requires the "replacement" string parameter containing ONLY the replacement text for the selected range.'
        );
      }

      const rangeResult = applyRangeReplacement(originalContent, activeInlineCtx, {
        replacement: input.replacement,
        expandedRange: input.expandedRange,
        expansionReason: input.expansionReason,
      });

      finalProposedContent = rangeResult.reconstructedContent;
      selectionRange = rangeResult.effectiveRange;
      prefixPreserved = rangeResult.prefixPreserved;
      suffixPreserved = rangeResult.suffixPreserved;
      selectionExpansion = rangeResult.selectionExpansion;
    } else {
      // Explicit full-file edit (Agent Mode or new file creation)
      const fullContent = input.content ?? input.proposedContent;
      if (typeof fullContent !== "string") {
        throw new SecurityError('Full-file proposal requires a UTF-8 "content" string.');
      }
      if (!isNewFile && originalContent.trim().length > 0 && fullContent.trim().length === 0) {
        throw new RangeEditValidationError(
          "EMPTY_REPLACEMENT",
          `Refusing to replace non-empty file "${relativePath}" with empty content.`
        );
      }
      finalProposedContent = fullContent;

      if (
        !isNewFile &&
        payload.selectionConstraint &&
        payload.selectionConstraint.relativePath.replace(/\\/g, "/").toLowerCase() ===
          relativePath.toLowerCase()
      ) {
        selectionExpansion = detectSelectionExpansion(
          originalContent,
          finalProposedContent,
          payload.selectionConstraint.startLine,
          payload.selectionConstraint.endLine
        );
      }
    }

    const byteLength = Buffer.byteLength(finalProposedContent, "utf8");
    if (byteLength > MAX_FILE_SIZE_BYTES) {
      throw new SecurityError(
        `Proposed file content (${byteLength} bytes) exceeds maximum limit of ${MAX_FILE_SIZE_BYTES} bytes.`
      );
    }

    const proposedSha256 = computeSha256(finalProposedContent);
    const hunks = generateDiffHunks(originalContent, finalProposedContent, 3);

    if (hunks.length === 0 && !isNewFile) {
      throw new Error(
        `Proposed content for "${relativePath}" has no line differences from the current file.`
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
      editMode,
      isNewFile,
      originalSha256,
      proposedSha256,
      originalContent,
      proposedContent: finalProposedContent,
      summary:
        input.summary?.trim() ||
        (isNewFile
          ? `Create new file ${relativePath}`
          : editMode === "range"
            ? `Inline range edit in ${relativePath}`
            : `Modify ${relativePath}`),
      hunks,
      status: "pending",
      createdAt: existingIdx >= 0 ? payload.proposals[existingIdx].createdAt : now,
      updatedAt: now,
      selectionRange,
      prefixPreserved,
      suffixPreserved,
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
