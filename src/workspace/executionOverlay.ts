import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CommandExecutionResult,
  executeSafeWorkspaceCommand,
  ValidatedCommandSpec,
} from "../security/commandPolicy";
import {
  PROTECTED_DIRECTORIES,
  resolveCanonicalWorkspaceRoot,
  resolveSafeWorkspacePath,
} from "../security/pathGuard";
import { isSensitiveFilePath } from "../security/secretFilter";
import { FileProposal } from "./proposalStore";

/**
 * PatchPilot Disposable Execution Overlay
 *
 * Copies the user's workspace snapshot into an isolated OS temp directory (excluding .git,
 * secrets, large vendor/venv folders, and symlinks), materializes active agent proposals into
 * the overlay, executes validated commands there, and unconditionally removes the overlay
 * when finished or cancelled. Never mutates the actual user workspace.
 */

export interface OverlayExecutionOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  secretsToRedact?: readonly string[];
}

export interface OverlayExecutionReport extends CommandExecutionResult {
  materializedProposals: string[];
  overlayCleanedUp: boolean;
}

const MAX_OVERLAY_FILES = 5000;
const MAX_OVERLAY_TOTAL_BYTES = 100 * 1024 * 1024; // 100 MiB safety cap

function copyWorkspaceSnapshotToOverlay(sourceRoot: string, overlayRoot: string): void {
  let fileCount = 0;
  let totalBytes = 0;

  const walk = (srcDir: string, dstDir: string): void => {
    fs.mkdirSync(dstDir, { recursive: true });
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(srcDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (fileCount >= MAX_OVERLAY_FILES || totalBytes >= MAX_OVERLAY_TOTAL_BYTES) {
        return;
      }

      // Never copy symlinks/junctions into the execution overlay
      if (entry.isSymbolicLink()) {
        continue;
      }

      const srcFull = path.join(srcDir, entry.name);
      const dstFull = path.join(dstDir, entry.name);
      const rel = path.relative(sourceRoot, srcFull).replace(/\\/g, "/");

      if (entry.isDirectory()) {
        if (PROTECTED_DIRECTORIES.has(entry.name.toLowerCase())) {
          continue;
        }
        walk(srcFull, dstFull);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (isSensitiveFilePath(rel)) {
        continue;
      }

      try {
        const stat = fs.statSync(srcFull);
        if (stat.size > 5 * 1024 * 1024) {
          continue; // Skip huge binary/data blobs
        }
        if (totalBytes + stat.size > MAX_OVERLAY_TOTAL_BYTES) {
          continue;
        }
        fs.copyFileSync(srcFull, dstFull);
        fileCount++;
        totalBytes += stat.size;
      } catch {
        // Skip unreadable files
      }
    }
  };

  walk(sourceRoot, overlayRoot);
}

/**
 * Materializes active proposals into a fresh temporary overlay and runs the validated command there.
 */
export async function runCommandInExecutionOverlay(
  workspaceRoot: string,
  proposals: readonly FileProposal[],
  commandSpec: ValidatedCommandSpec,
  options: OverlayExecutionOptions = {}
): Promise<OverlayExecutionReport> {
  const rootReal = resolveCanonicalWorkspaceRoot(workspaceRoot);
  const overlayRoot = path.join(os.tmpdir(), `patchpilot-overlay-${crypto.randomUUID()}`);
  const materializedProposals: string[] = [];

  try {
    fs.mkdirSync(overlayRoot, { recursive: true });
    copyWorkspaceSnapshotToOverlay(rootReal, overlayRoot);

    // Materialize active proposals strictly inside overlayRoot
    for (const prop of proposals) {
      if (prop.status !== "pending" && prop.status !== "partially_applied") {
        continue;
      }
      const safeOverlayTarget = resolveSafeWorkspacePath(overlayRoot, prop.relativePath, {
        checkExtension: true,
        mustExist: false,
        rejectSymlinks: true,
      });
      fs.mkdirSync(path.dirname(safeOverlayTarget), { recursive: true });
      fs.writeFileSync(safeOverlayTarget, prop.proposedContent, "utf8");
      materializedProposals.push(prop.relativePath);
    }

    // For Python src-layout repos (e.g. pallets/flask), prepend overlay/src to PYTHONPATH
    // so pytest and flask import the proposed overlay code instead of an editable host install.
    const extraEnv: Record<string, string> = {};
    const overlaySrcDir = path.join(overlayRoot, "src");
    if (fs.existsSync(overlaySrcDir) && fs.statSync(overlaySrcDir).isDirectory()) {
      const existingPyPath = process.env.PYTHONPATH;
      extraEnv.PYTHONPATH = existingPyPath
        ? `${overlaySrcDir}${path.delimiter}${overlayRoot}${path.delimiter}${existingPyPath}`
        : `${overlaySrcDir}${path.delimiter}${overlayRoot}`;
    }

    const result = await executeSafeWorkspaceCommand(commandSpec, {
      cwd: overlayRoot,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      extraEnv,
      secretsToRedact: options.secretsToRedact,
    });

    let overlayCleanedUp = false;
    try {
      fs.rmSync(overlayRoot, { recursive: true, force: true });
      overlayCleanedUp = !fs.existsSync(overlayRoot);
    } catch {
      overlayCleanedUp = false;
    }

    return {
      ...result,
      materializedProposals,
      overlayCleanedUp,
    };
  } finally {
    if (fs.existsSync(overlayRoot)) {
      try {
        fs.rmSync(overlayRoot, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    }
  }
}
