import * as crypto from "node:crypto";

/**
 * PatchPilot Pure TypeScript Diff, Hunk Decomposition & Selective Application Engine
 *
 * Computes deterministic line-level unified diff hunks and reconstructs target file
 * contents applying strictly user-accepted hunks while preserving rejected/pending hunks
 * and original line-ending style.
 */

export type HunkDecision = "pending" | "accepted" | "rejected";

export interface DiffLine {
  type: "context" | "add" | "remove";
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export interface DiffHunk {
  id: string;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  addedCount: number;
  removedCount: number;
  lines: DiffLine[];
  decision: HunkDecision;
}

export interface SelectionExpansionReport {
  expanded: boolean;
  selectionStartLine: number;
  selectionEndLine: number;
  changedRanges: Array<{ startLine: number; endLine: number }>;
  reason?: string;
}

interface RawEditOp {
  type: "equal" | "remove" | "add";
  line: string;
  oldIdx?: number; // 0-based
  newIdx?: number; // 0-based
}

export function computeSha256(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function detectEol(content: string): "\r\n" | "\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function splitLinesPreservingMeta(content: string): { lines: string[]; hasTrailingNewline: boolean } {
  if (content.length === 0) {
    return { lines: [], hasTrailingNewline: false };
  }
  const hasTrailingNewline = content.endsWith("\n");
  const normalized = content.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n");
  if (hasTrailingNewline) {
    parts.pop();
  }
  return { lines: parts, hasTrailingNewline };
}

/**
 * Computes line-level diff operations using bounded Myers/LCS with common prefix/suffix trimming.
 */
function computeLineOps(oldLines: string[], newLines: string[]): RawEditOp[] {
  const n = oldLines.length;
  const m = newLines.length;

  // Trim identical prefix and suffix to keep DP matrix tiny on large source files
  let prefix = 0;
  while (prefix < n && prefix < m && oldLines[prefix] === newLines[prefix]) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < n - prefix &&
    suffix < m - prefix &&
    oldLines[n - 1 - suffix] === newLines[m - 1 - suffix]
  ) {
    suffix++;
  }

  const ops: RawEditOp[] = [];
  for (let i = 0; i < prefix; i++) {
    ops.push({ type: "equal", line: oldLines[i], oldIdx: i, newIdx: i });
  }

  const oldMid = oldLines.slice(prefix, n - suffix);
  const newMid = newLines.slice(prefix, m - suffix);
  const aLen = oldMid.length;
  const bLen = newMid.length;

  if (aLen === 0) {
    for (let j = 0; j < bLen; j++) {
      ops.push({ type: "add", line: newMid[j], newIdx: prefix + j });
    }
  } else if (bLen === 0) {
    for (let i = 0; i < aLen; i++) {
      ops.push({ type: "remove", line: oldMid[i], oldIdx: prefix + i });
    }
  } else if (aLen * bLen <= 4_000_000) {
    // Standard LCS DP table
    const width = bLen + 1;
    const dp = new Int32Array((aLen + 1) * width);

    for (let i = aLen - 1; i >= 0; i--) {
      const rowOffset = i * width;
      const nextRowOffset = (i + 1) * width;
      for (let j = bLen - 1; j >= 0; j--) {
        if (oldMid[i] === newMid[j]) {
          dp[rowOffset + j] = dp[nextRowOffset + j + 1] + 1;
        } else {
          const down = dp[nextRowOffset + j];
          const right = dp[rowOffset + j + 1];
          dp[rowOffset + j] = down >= right ? down : right;
        }
      }
    }

    let i = 0;
    let j = 0;
    while (i < aLen && j < bLen) {
      if (oldMid[i] === newMid[j]) {
        ops.push({ type: "equal", line: oldMid[i], oldIdx: prefix + i, newIdx: prefix + j });
        i++;
        j++;
      } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
        ops.push({ type: "remove", line: oldMid[i], oldIdx: prefix + i });
        i++;
      } else {
        ops.push({ type: "add", line: newMid[j], newIdx: prefix + j });
        j++;
      }
    }
    while (i < aLen) {
      ops.push({ type: "remove", line: oldMid[i], oldIdx: prefix + i });
      i++;
    }
    while (j < bLen) {
      ops.push({ type: "add", line: newMid[j], newIdx: prefix + j });
      j++;
    }
  } else {
    // Fallback for extremely large fully-divergent diffs: replace block atomically
    for (let i = 0; i < aLen; i++) {
      ops.push({ type: "remove", line: oldMid[i], oldIdx: prefix + i });
    }
    for (let j = 0; j < bLen; j++) {
      ops.push({ type: "add", line: newMid[j], newIdx: prefix + j });
    }
  }

  for (let s = 0; s < suffix; s++) {
    const oldIdx = n - suffix + s;
    const newIdx = m - suffix + s;
    ops.push({ type: "equal", line: oldLines[oldIdx], oldIdx, newIdx });
  }

  return ops;
}

/**
 * Generates discrete reviewable unified diff hunks between original and proposed content.
 */
export function generateDiffHunks(
  originalContent: string,
  proposedContent: string,
  contextLines: number = 3
): DiffHunk[] {
  if (originalContent === proposedContent) {
    return [];
  }

  const origMeta = splitLinesPreservingMeta(originalContent);
  const propMeta = splitLinesPreservingMeta(proposedContent);
  const ops = computeLineOps(origMeta.lines, propMeta.lines);

  const changeIndices: number[] = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type !== "equal") {
      changeIndices.push(i);
    }
  }

  if (changeIndices.length === 0) {
    // Only line-ending or trailing-newline difference
    return [];
  }

  // Group nearby changes separated by <= 2 * contextLines
  const groups: Array<{ startOp: number; endOp: number }> = [];
  let curStart = Math.max(0, changeIndices[0] - contextLines);
  let curEnd = Math.min(ops.length - 1, changeIndices[0] + contextLines);

  for (let k = 1; k < changeIndices.length; k++) {
    const nextStart = Math.max(0, changeIndices[k] - contextLines);
    const nextEnd = Math.min(ops.length - 1, changeIndices[k] + contextLines);
    if (nextStart <= curEnd + 1) {
      curEnd = Math.max(curEnd, nextEnd);
    } else {
      groups.push({ startOp: curStart, endOp: curEnd });
      curStart = nextStart;
      curEnd = nextEnd;
    }
  }
  groups.push({ startOp: curStart, endOp: curEnd });

  const hunks: DiffHunk[] = [];

  for (let gIdx = 0; gIdx < groups.length; gIdx++) {
    const group = groups[gIdx];
    const slice = ops.slice(group.startOp, group.endOp + 1);

    let firstOld: number | undefined;
    let firstNew: number | undefined;
    let oldCount = 0;
    let newCount = 0;
    let addedCount = 0;
    let removedCount = 0;
    const diffLines: DiffLine[] = [];

    for (const op of slice) {
      if (op.type === "equal") {
        const oldLn = (op.oldIdx ?? 0) + 1;
        const newLn = (op.newIdx ?? 0) + 1;
        if (firstOld === undefined) firstOld = oldLn;
        if (firstNew === undefined) firstNew = newLn;
        oldCount++;
        newCount++;
        diffLines.push({
          type: "context",
          content: op.line,
          oldLineNumber: oldLn,
          newLineNumber: newLn,
        });
      } else if (op.type === "remove") {
        const oldLn = (op.oldIdx ?? 0) + 1;
        if (firstOld === undefined) firstOld = oldLn;
        oldCount++;
        removedCount++;
        diffLines.push({
          type: "remove",
          content: op.line,
          oldLineNumber: oldLn,
        });
      } else {
        const newLn = (op.newIdx ?? 0) + 1;
        if (firstNew === undefined) firstNew = newLn;
        newCount++;
        addedCount++;
        diffLines.push({
          type: "add",
          content: op.line,
          newLineNumber: newLn,
        });
      }
    }

    // Pure insertion or pure deletion edge case
    if (firstOld === undefined) {
      let prevOld = 0;
      for (let p = group.startOp - 1; p >= 0; p--) {
        if (ops[p].oldIdx !== undefined) {
          prevOld = (ops[p].oldIdx as number) + 1;
          break;
        }
      }
      firstOld = oldCount === 0 ? prevOld : prevOld + 1;
    }

    if (firstNew === undefined) {
      let prevNew = 0;
      for (let p = group.startOp - 1; p >= 0; p--) {
        if (ops[p].newIdx !== undefined) {
          prevNew = (ops[p].newIdx as number) + 1;
          break;
        }
      }
      firstNew = newCount === 0 ? prevNew : prevNew + 1;
    }

    const header = `@@ -${firstOld},${oldCount} +${firstNew},${newCount} @@`;
    hunks.push({
      id: `hunk-${gIdx + 1}`,
      header,
      oldStart: firstOld,
      oldLines: oldCount,
      newStart: firstNew,
      newLines: newCount,
      addedCount,
      removedCount,
      lines: diffLines,
      decision: "pending",
    });
  }

  return hunks;
}

/**
 * Applies ONLY hunks with decision === "accepted" to originalContent,
 * keeping rejected/pending hunks and all unrelated content completely untouched.
 */
export function applySelectedHunks(
  originalContent: string,
  hunks: readonly DiffHunk[],
  proposedContentForEol?: string
): string {
  const acceptedHunks = hunks.filter((h) => h.decision === "accepted");
  if (acceptedHunks.length === 0) {
    return originalContent;
  }

  const eol =
    originalContent.length > 0
      ? detectEol(originalContent)
      : detectEol(proposedContentForEol ?? "\n");
  const origMeta = splitLinesPreservingMeta(originalContent);
  const propTrailing =
    proposedContentForEol !== undefined
      ? proposedContentForEol.endsWith("\n")
      : origMeta.hasTrailingNewline || originalContent.length === 0;

  const sorted = [...acceptedHunks].sort((a, b) => a.oldStart - b.oldStart);
  const resultLines: string[] = [];
  let cursor = 0; // 0-based index into origMeta.lines

  for (const hunk of sorted) {
    // For pure insertions (oldLines === 0), oldStart is the 1-based line AFTER which to insert (0 = start)
    const hunkStartIdx =
      hunk.oldLines === 0 ? Math.max(0, hunk.oldStart) : Math.max(0, hunk.oldStart - 1);

    if (hunkStartIdx < cursor) {
      throw new Error(`Overlapping hunk detected while applying ${hunk.id} at line ${hunk.oldStart}.`);
    }

    // Copy unmodified original lines before this hunk
    while (cursor < hunkStartIdx && cursor < origMeta.lines.length) {
      resultLines.push(origMeta.lines[cursor]);
      cursor++;
    }

    // Verify context/removed lines match and emit context/added lines
    for (const line of hunk.lines) {
      if (line.type === "context") {
        if (cursor < origMeta.lines.length && origMeta.lines[cursor] !== line.content) {
          throw new Error(
            `Context mismatch while applying ${hunk.id} at original line ${cursor + 1}.`
          );
        }
        resultLines.push(line.content);
        cursor++;
      } else if (line.type === "remove") {
        if (cursor < origMeta.lines.length && origMeta.lines[cursor] !== line.content) {
          throw new Error(
            `Removal mismatch while applying ${hunk.id} at original line ${cursor + 1}.`
          );
        }
        cursor++;
      } else {
        resultLines.push(line.content);
      }
    }
  }

  // Copy remaining original lines after last accepted hunk
  while (cursor < origMeta.lines.length) {
    resultLines.push(origMeta.lines[cursor]);
    cursor++;
  }

  if (resultLines.length === 0) {
    return "";
  }

  const joined = resultLines.join(eol);
  return propTrailing ? `${joined}${eol}` : joined;
}

/**
 * Formats hunks into a standard unified diff string for display or MCP tool responses.
 */
export function formatUnifiedDiff(relativePath: string, hunks: readonly DiffHunk[]): string {
  if (hunks.length === 0) {
    return "";
  }
  const out: string[] = [`--- a/${relativePath}`, `+++ b/${relativePath}`];
  for (const hunk of hunks) {
    out.push(hunk.header);
    for (const line of hunk.lines) {
      const prefix = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
      out.push(`${prefix}${line.content}`);
    }
  }
  return out.join("\n");
}

/**
 * Checks whether an inline edit modifies lines outside the originally selected 1-based line range.
 */
export function detectSelectionExpansion(
  originalContent: string,
  proposedContent: string,
  selectionStartLine: number,
  selectionEndLine: number
): SelectionExpansionReport {
  const hunks = generateDiffHunks(originalContent, proposedContent, 0);
  const changedRanges: Array<{ startLine: number; endLine: number }> = [];
  let expanded = false;

  for (const hunk of hunks) {
    const startLine = Math.max(1, hunk.oldStart);
    const endLine =
      hunk.oldLines > 0 ? hunk.oldStart + hunk.oldLines - 1 : Math.max(1, hunk.oldStart);
    changedRanges.push({ startLine, endLine });

    if (startLine < selectionStartLine || endLine > selectionEndLine) {
      expanded = true;
    }
  }

  return {
    expanded,
    selectionStartLine,
    selectionEndLine,
    changedRanges,
    reason: expanded
      ? `Proposed edit modifies lines outside the selected range (${selectionStartLine}-${selectionEndLine}). Explicit hunk review is required.`
      : undefined,
  };
}
