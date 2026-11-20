import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { resolveCanonicalWorkspaceRoot, resolveSafeWorkspacePath } from "../security/pathGuard";
import { computeSha256 } from "./patchEngine";

/**
 * PatchPilot Undo Manager
 *
 * Tracks applied change batches with pre-apply and post-apply SHA-256 content hashes.
 * Verifies post-apply hashes before restoring previous content or deleting newly created files
 * so user edits made after PatchPilot applied changes are NEVER silently overwritten.
 */

export interface UndoFileEntry {
  relativePath: string;
  isNewFile: boolean;
  beforeContent: string | null;
  beforeSha256: string | null;
  afterSha256: string;
  appliedHunkIds: string[];
}

export interface UndoBatch {
  batchId: string;
  workspaceRoot: string;
  appliedAt: string;
  entries: UndoFileEntry[];
}

export interface WorkspaceFileMutations {
  writeFile(absolutePath: string, content: string, isNewFile: boolean): Promise<void>;
  deleteFile(absolutePath: string): Promise<void>;
}

export interface UndoConflict {
  relativePath: string;
  reason: string;
}

export interface UndoResult {
  success: boolean;
  batchId?: string;
  restoredFiles: string[];
  deletedNewFiles: string[];
  conflicts: UndoConflict[];
  message: string;
}

export const defaultFsMutations: WorkspaceFileMutations = {
  async writeFile(absolutePath: string, content: string): Promise<void> {
    await fs.promises.writeFile(absolutePath, content, "utf8");
  },
  async deleteFile(absolutePath: string): Promise<void> {
    await fs.promises.rm(absolutePath, { force: true });
  },
};

export class UndoManager {
  private readonly history: UndoBatch[] = [];
  private readonly maxBatches: number;

  constructor(maxBatches: number = 25) {
    this.maxBatches = maxBatches;
  }

  public recordBatch(workspaceRoot: string, entries: UndoFileEntry[]): UndoBatch {
    const batch: UndoBatch = {
      batchId: `undo-${crypto.randomBytes(6).toString("hex")}`,
      workspaceRoot: resolveCanonicalWorkspaceRoot(workspaceRoot),
      appliedAt: new Date().toISOString(),
      entries: [...entries],
    };
    this.history.push(batch);
    if (this.history.length > this.maxBatches) {
      this.history.shift();
    }
    return batch;
  }

  public hasUndoableBatch(): boolean {
    return this.history.length > 0;
  }

  public peekLastBatch(): UndoBatch | undefined {
    return this.history[this.history.length - 1];
  }

  public getBatchCount(): number {
    return this.history.length;
  }

  /**
   * Reverts the most recently applied PatchPilot batch after verifying no post-apply user edits occurred.
   */
  public async undoLastApply(
    mutations: WorkspaceFileMutations = defaultFsMutations
  ): Promise<UndoResult> {
    const batch = this.peekLastBatch();
    if (!batch) {
      return {
        success: false,
        restoredFiles: [],
        deletedNewFiles: [],
        conflicts: [],
        message: "No applied PatchPilot changes available to undo.",
      };
    }

    const conflicts: UndoConflict[] = [];
    const verifiedPaths = new Map<string, string>();

    // Phase 1: Validate every file before mutating anything (all-or-nothing conflict safety)
    for (const entry of batch.entries) {
      let safePath: string;
      try {
        safePath = resolveSafeWorkspacePath(batch.workspaceRoot, entry.relativePath, {
          checkExtension: true,
          mustExist: true,
          rejectSymlinks: true,
        });
      } catch (err: unknown) {
        conflicts.push({
          relativePath: entry.relativePath,
          reason: `File missing or inaccessible for undo: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }

      const currentContent = await fs.promises.readFile(safePath, "utf8");
      const currentSha = computeSha256(currentContent);
      if (currentSha !== entry.afterSha256) {
        conflicts.push({
          relativePath: entry.relativePath,
          reason:
            "File was modified after PatchPilot applied changes (post-apply SHA-256 mismatch). Refusing to overwrite newer edits.",
        });
        continue;
      }

      verifiedPaths.set(entry.relativePath, safePath);
    }

    if (conflicts.length > 0) {
      return {
        success: false,
        batchId: batch.batchId,
        restoredFiles: [],
        deletedNewFiles: [],
        conflicts,
        message: `Undo aborted due to ${conflicts.length} conflict(s): ${conflicts.map((c) => c.relativePath).join(", ")}.`,
      };
    }

    // Phase 2: Perform verified restore/delete
    const restoredFiles: string[] = [];
    const deletedNewFiles: string[] = [];

    for (const entry of batch.entries) {
      const safePath = verifiedPaths.get(entry.relativePath)!;
      if (entry.isNewFile) {
        await mutations.deleteFile(safePath);
        deletedNewFiles.push(entry.relativePath);
      } else {
        await mutations.writeFile(safePath, entry.beforeContent ?? "", false);
        restoredFiles.push(entry.relativePath);
      }
    }

    this.history.pop();

    return {
      success: true,
      batchId: batch.batchId,
      restoredFiles,
      deletedNewFiles,
      conflicts: [],
      message: `Successfully undone batch ${batch.batchId}: restored ${restoredFiles.length} file(s), removed ${deletedNewFiles.length} created file(s).`,
    };
  }
}
