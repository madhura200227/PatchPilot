import * as fs from "node:fs";
import * as path from "node:path";
import { resolveCanonicalWorkspaceRoot, resolveSafeWorkspacePath } from "../security/pathGuard";
import { applySelectedHunks, computeSha256 } from "./patchEngine";
import { FileProposal, ProposalStore } from "./proposalStore";
import { defaultFsMutations, UndoFileEntry, UndoManager, WorkspaceFileMutations } from "./undoManager";

/**
 * PatchPilot Hunk Review & Safe Application Coordinator
 *
 * Revalidates paths and original content hashes before applying ONLY accepted hunks,
 * detects stale proposals (files edited after proposal creation), records Undo batches,
 * and never silently overwrites newer user changes.
 */

export interface AppliedFileSummary {
  proposalId: string;
  relativePath: string;
  isNewFile: boolean;
  appliedHunkIds: string[];
  rejectedOrPendingHunkIds: string[];
  resultingSha256: string;
}

export interface StaleProposalConflict {
  proposalId: string;
  relativePath: string;
  reason: string;
}

export interface ApplyAcceptedResult {
  appliedFiles: AppliedFileSummary[];
  staleConflicts: StaleProposalConflict[];
  undoBatchId?: string;
  message: string;
}

/**
 * Checks whether a proposal is stale relative to the current workspace disk state.
 */
export async function checkProposalStaleness(
  workspaceRoot: string,
  proposal: FileProposal
): Promise<{ stale: boolean; reason?: string; currentContent?: string; safePath?: string }> {
  const rootReal = resolveCanonicalWorkspaceRoot(workspaceRoot);
  let safePath: string;
  try {
    safePath = resolveSafeWorkspacePath(rootReal, proposal.relativePath, {
      checkExtension: true,
      mustExist: false,
      rejectSymlinks: true,
    });
  } catch (err: unknown) {
    return {
      stale: true,
      reason: `Path failed safety revalidation: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const exists = fs.existsSync(safePath);
  if (proposal.isNewFile) {
    if (exists) {
      return {
        stale: true,
        reason: `Target new file "${proposal.relativePath}" already exists on disk.`,
      };
    }
    return { stale: false, currentContent: "", safePath };
  }

  if (!exists) {
    return {
      stale: true,
      reason: `Original file "${proposal.relativePath}" no longer exists on disk.`,
    };
  }

  const currentContent = await fs.promises.readFile(safePath, "utf8");
  const currentSha = computeSha256(currentContent);
  if (currentSha !== proposal.originalSha256) {
    return {
      stale: true,
      reason: `File "${proposal.relativePath}" changed on disk after proposal creation (hash mismatch).`,
    };
  }

  return { stale: false, currentContent, safePath };
}

/**
 * Applies only explicitly accepted hunks across all eligible proposals.
 */
export async function applyAcceptedProposals(
  workspaceRoot: string,
  proposalStore: ProposalStore,
  undoManager: UndoManager,
  mutations: WorkspaceFileMutations = defaultFsMutations
): Promise<ApplyAcceptedResult> {
  const rootReal = resolveCanonicalWorkspaceRoot(workspaceRoot);
  const proposals = proposalStore.listProposals();

  const appliedFiles: AppliedFileSummary[] = [];
  const staleConflicts: StaleProposalConflict[] = [];
  const undoEntries: UndoFileEntry[] = [];

  for (const proposal of proposals) {
    const acceptedHunks = proposal.hunks.filter((h) => h.decision === "accepted");
    if (acceptedHunks.length === 0) {
      continue;
    }

    const staleness = await checkProposalStaleness(rootReal, proposal);
    if (staleness.stale || !staleness.safePath) {
      const reason = staleness.reason ?? "Proposal is stale.";
      proposalStore.markProposalStatus(proposal.proposalId, "stale", reason);
      staleConflicts.push({
        proposalId: proposal.proposalId,
        relativePath: proposal.relativePath,
        reason,
      });
      continue;
    }

    const resultingContent = applySelectedHunks(
      proposal.originalContent,
      proposal.hunks,
      proposal.proposedContent
    );

    if (proposal.isNewFile) {
      await fs.promises.mkdir(path.dirname(staleness.safePath), { recursive: true });
    }

    await mutations.writeFile(staleness.safePath, resultingContent, proposal.isNewFile);

    const resultingSha = computeSha256(resultingContent);
    const appliedHunkIds = acceptedHunks.map((h) => h.id);
    const rejectedOrPendingHunkIds = proposal.hunks
      .filter((h) => h.decision !== "accepted")
      .map((h) => h.id);

    undoEntries.push({
      relativePath: proposal.relativePath,
      isNewFile: proposal.isNewFile,
      beforeContent: proposal.isNewFile ? null : proposal.originalContent,
      beforeSha256: proposal.originalSha256,
      afterSha256: resultingSha,
      appliedHunkIds,
    });

    proposalStore.markProposalStatus(
      proposal.proposalId,
      rejectedOrPendingHunkIds.length === 0 ? "applied" : "partially_applied"
    );

    appliedFiles.push({
      proposalId: proposal.proposalId,
      relativePath: proposal.relativePath,
      isNewFile: proposal.isNewFile,
      appliedHunkIds,
      rejectedOrPendingHunkIds,
      resultingSha256: resultingSha,
    });
  }

  let undoBatchId: string | undefined;
  if (undoEntries.length > 0) {
    const batch = undoManager.recordBatch(rootReal, undoEntries);
    undoBatchId = batch.batchId;
  }

  const totalHunks = appliedFiles.reduce((sum, f) => sum + f.appliedHunkIds.length, 0);
  let message: string;
  if (appliedFiles.length === 0 && staleConflicts.length === 0) {
    message = "No accepted hunks selected to apply. Accept at least one hunk in the review panel first.";
  } else if (staleConflicts.length > 0) {
    message = `Applied ${totalHunks} hunk(s) across ${appliedFiles.length} file(s); skipped ${staleConflicts.length} stale proposal(s) to protect newer edits.`;
  } else {
    message = `Applied ${totalHunks} accepted hunk(s) across ${appliedFiles.length} file(s).`;
  }

  return {
    appliedFiles,
    staleConflicts,
    undoBatchId,
    message,
  };
}
