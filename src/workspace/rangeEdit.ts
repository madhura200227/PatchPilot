import {
  computeSha256,
  detectSelectionExpansion,
  generateDiffHunks,
  SelectionExpansionReport,
} from "./patchEngine";

/**
 * PatchPilot Explicit Range-Edit Transformation & Preservation Engine
 *
 * Enforces all six inline-edit preservation invariants using zero-based UTF-16
 * coordinates compatible with VS Code TextDocument positions/offsets and JavaScript strings:
 *   1. Exact prefix preservation before the selected range.
 *   2. Exact suffix preservation after the selected range.
 *   3. Stale document & selection-boundary verification (SHA-256 + verbatim slice check).
 *   4. Rejection of empty, truncated, markdown-fenced, or accidental full-file replacements.
 *   5. Proposal-only operation (pure string transformation; zero disk writes).
 *   6. Explicit expanded-range protocol requiring both expandedRange and expansionReason.
 */

export type EditMode = "range" | "full_file";

export interface ZeroBasedPosition {
  /** 0-based line index (matches vscode.Position.line) */
  line: number;
  /** 0-based UTF-16 code-unit column offset within the line (matches vscode.Position.character) */
  character: number;
}

export interface ZeroBasedRange {
  start: ZeroBasedPosition;
  end: ZeroBasedPosition;
}

export interface InlineEditContext {
  relativePath: string;
  originalSha256: string;
  originalVersion: number;
  /** Canonical 0-based UTF-16 line/character range */
  range: ZeroBasedRange;
  /** Exact UTF-16 code-unit start offset in originalContent */
  startOffset: number;
  /** Exact UTF-16 code-unit end offset in originalContent */
  endOffset: number;
  /** Exact verbatim substring: originalContent.slice(startOffset, endOffset) */
  selectedText: string;
  /** Original file line-ending style */
  eol: "\r\n" | "\n";
  /** 1-based inclusive line numbers for display */
  displayStartLine: number;
  displayEndLine: number;
}

export type RangeEditErrorCode =
  | "INVALID_RANGE"
  | "STALE_DOCUMENT"
  | "SELECTION_MISMATCH"
  | "EMPTY_REPLACEMENT"
  | "MALFORMED_REPLACEMENT"
  | "TRUNCATED_REPLACEMENT"
  | "ACCIDENTAL_FULL_FILE_IN_RANGE_MODE"
  | "MISSING_EXPANSION_REASON"
  | "FULL_FILE_REJECTED_IN_INLINE_EDIT"
  | "NO_CHANGES"
  | "PRESERVATION_INVARIANT_FAILED";

export class RangeEditValidationError extends Error {
  public readonly code: RangeEditErrorCode;

  constructor(code: RangeEditErrorCode, message: string) {
    super(message);
    this.name = "RangeEditValidationError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface RangeReplacementInput {
  replacement: string;
  expandedRange?: ZeroBasedRange;
  expansionReason?: string;
}

export interface RangeReplacementResult {
  reconstructedContent: string;
  normalizedReplacement: string;
  effectiveRange: ZeroBasedRange;
  effectiveStartOffset: number;
  effectiveEndOffset: number;
  prefixLength: number;
  suffixLength: number;
  prefixPreserved: boolean;
  suffixPreserved: boolean;
  selectionExpansion?: SelectionExpansionReport & { explicitlyRequested?: boolean };
}

interface LineSpan {
  /** Start UTF-16 offset of this line */
  start: number;
  /** End UTF-16 offset excluding line terminator (\r\n or \n) */
  endWithoutEol: number;
  /** End UTF-16 offset including line terminator */
  endWithEol: number;
}

function indexLineSpans(content: string): LineSpan[] {
  const spans: LineSpan[] = [];
  let lineStart = 0;
  let i = 0;

  while (i < content.length) {
    const ch = content.charCodeAt(i);
    if (ch === 13 /* \r */) {
      const hasLf = i + 1 < content.length && content.charCodeAt(i + 1) === 10 /* \n */;
      const endWithEol = hasLf ? i + 2 : i + 1;
      spans.push({ start: lineStart, endWithoutEol: i, endWithEol });
      i = endWithEol;
      lineStart = i;
    } else if (ch === 10 /* \n */) {
      const endWithEol = i + 1;
      spans.push({ start: lineStart, endWithoutEol: i, endWithEol });
      i = endWithEol;
      lineStart = i;
    } else {
      i++;
    }
  }

  // Always include final line (even empty trailing line after final newline, matching VS Code)
  spans.push({ start: lineStart, endWithoutEol: content.length, endWithEol: content.length });
  return spans;
}

export function detectFileEol(content: string): "\r\n" | "\n" {
  const firstLf = content.indexOf("\n");
  if (firstLf > 0 && content.charCodeAt(firstLf - 1) === 13) {
    return "\r\n";
  }
  return "\n";
}

export function normalizeReplacementEol(replacement: string, targetEol: "\r\n" | "\n"): string {
  const lfOnly = replacement.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return targetEol === "\r\n" ? lfOnly.replace(/\n/g, "\r\n") : lfOnly;
}

/**
 * Converts a zero-based UTF-16 Position (matching vscode.Position) to a UTF-16 string offset.
 */
export function positionToUtf16Offset(content: string, pos: ZeroBasedPosition): number {
  if (
    !pos ||
    typeof pos.line !== "number" ||
    typeof pos.character !== "number" ||
    !Number.isInteger(pos.line) ||
    !Number.isInteger(pos.character) ||
    pos.line < 0 ||
    pos.character < 0
  ) {
    throw new RangeEditValidationError(
      "INVALID_RANGE",
      `Invalid zero-based position: ${JSON.stringify(pos)}`
    );
  }

  const spans = indexLineSpans(content);
  if (pos.line >= spans.length) {
    throw new RangeEditValidationError(
      "INVALID_RANGE",
      `Line index ${pos.line} is out of bounds (document has ${spans.length} lines).`
    );
  }

  const span = spans[pos.line];
  const lineLen = span.endWithoutEol - span.start;
  if (pos.character > lineLen) {
    throw new RangeEditValidationError(
      "INVALID_RANGE",
      `Character index ${pos.character} exceeds line ${pos.line} length (${lineLen}).`
    );
  }

  return span.start + pos.character;
}

/**
 * Converts a UTF-16 string offset into a zero-based Position (matching vscode.TextDocument.positionAt).
 */
export function utf16OffsetToPosition(content: string, offset: number): ZeroBasedPosition {
  if (!Number.isInteger(offset) || offset < 0 || offset > content.length) {
    throw new RangeEditValidationError(
      "INVALID_RANGE",
      `UTF-16 offset ${offset} is out of bounds [0, ${content.length}].`
    );
  }

  const spans = indexLineSpans(content);
  for (let line = 0; line < spans.length; line++) {
    const span = spans[line];
    if (offset <= span.endWithoutEol) {
      return { line, character: offset - span.start };
    }
    if (offset < span.endWithEol) {
      // Offset points inside a \r\n sequence; clamp to end of line
      return { line, character: span.endWithoutEol - span.start };
    }
  }

  const lastIdx = spans.length - 1;
  return { line: lastIdx, character: spans[lastIdx].endWithoutEol - spans[lastIdx].start };
}

/**
 * Captures an immutable, hash-anchored InlineEditContext from a file and zero-based selection range.
 */
export function captureSelectionContext(
  relativePath: string,
  fullContent: string,
  range: ZeroBasedRange,
  originalVersion: number = 1
): InlineEditContext {
  const startOffset = positionToUtf16Offset(fullContent, range.start);
  const endOffset = positionToUtf16Offset(fullContent, range.end);

  if (endOffset <= startOffset) {
    throw new RangeEditValidationError(
      "INVALID_RANGE",
      "Inline edit selection must be non-empty (end offset must be strictly greater than start offset)."
    );
  }

  const selectedText = fullContent.slice(startOffset, endOffset);
  const displayStartLine = range.start.line + 1;
  // If selection ends at column 0 of the next line, the last selected visual line is end.line
  const displayEndLine =
    range.end.character === 0 && range.end.line > range.start.line
      ? range.end.line
      : range.end.line + 1;

  return {
    relativePath: relativePath.replace(/\\/g, "/"),
    originalSha256: computeSha256(fullContent),
    originalVersion,
    range: {
      start: { line: range.start.line, character: range.start.character },
      end: { line: range.end.line, character: range.end.character },
    },
    startOffset,
    endOffset,
    selectedText,
    eol: detectFileEol(fullContent),
    displayStartLine,
    displayEndLine,
  };
}

const TRUNCATION_PLACEHOLDER_PATTERNS = [
  /^\s*(?:#|\/\/|\/\*)\s*\.\.\.\s*(?:rest of (?:the )?file|remaining|unchanged|omitted|existing code|snip)/im,
  /^\s*\.\.\.\s*(?:rest of (?:the )?file|unchanged|omitted)\s*$/im,
  /\[\s*(?:rest of file omitted|truncated|unchanged code omitted)\s*\]/i,
];

function countNonOverlapping(text: string, token: string): number {
  let count = 0;
  let idx = 0;
  while ((idx = text.indexOf(token, idx)) !== -1) {
    count++;
    idx += token.length;
  }
  return count;
}

function delimiterBalance(text: string): { paren: number; bracket: number; brace: number } {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && (inSingle || inDouble)) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) {
      continue;
    }
    if (ch === "(") paren++;
    else if (ch === ")") paren--;
    else if (ch === "[") bracket++;
    else if (ch === "]") bracket--;
    else if (ch === "{") brace++;
    else if (ch === "}") brace--;
  }
  return { paren, bracket, brace };
}

function getDistinctNonEmptyLines(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length >= 12);
}

/**
 * Validates a replacement string for range-edit mode (Invariant 4):
 * rejects empty, markdown-fenced, placeholder-truncated, syntactically cut-off,
 * or accidental full-file/unselected-prefix/suffix pastes.
 */
function validateReplacementFragment(
  replacement: string,
  effectiveSelectedText: string,
  prefix: string,
  suffix: string
): void {
  if (typeof replacement !== "string") {
    throw new RangeEditValidationError(
      "MALFORMED_REPLACEMENT",
      "Replacement text must be a string."
    );
  }

  if (replacement.trim().length === 0) {
    throw new RangeEditValidationError(
      "EMPTY_REPLACEMENT",
      "Replacement text is empty or whitespace-only; refusing to delete the selected region."
    );
  }

  // Reject accidental markdown code fences wrapped around replacement
  const trimmed = replacement.trim();
  if (/^```[a-zA-Z0-9_-]*\r?\n/.test(trimmed) && /\r?\n```$/.test(trimmed)) {
    throw new RangeEditValidationError(
      "MALFORMED_REPLACEMENT",
      "Replacement text is wrapped in markdown code fences (```). Supply raw source code only."
    );
  }

  // Reject explicit truncation placeholders
  for (const pat of TRUNCATION_PLACEHOLDER_PATTERNS) {
    if (pat.test(replacement)) {
      throw new RangeEditValidationError(
        "TRUNCATED_REPLACEMENT",
        "Replacement contains truncation placeholder markers (e.g., '... rest of file ...'). Supply the complete replacement for the selected range."
      );
    }
  }

  // Check for accidental full-file or unselected prefix/suffix inclusion when unselected code exists
  const selectedLineSet = new Set(getDistinctNonEmptyLines(effectiveSelectedText));
  const repLines = getDistinctNonEmptyLines(replacement);

  if (prefix.trim().length >= 30 && repLines.length >= 2) {
    const prefixLines = getDistinctNonEmptyLines(prefix).filter((l) => !selectedLineSet.has(l));
    if (prefixLines.length > 0) {
      // Check if replacement starts with the file's unselected top lines (e.g. imports / module header)
      const firstPrefixLine = prefixLines[0];
      if (repLines[0] === firstPrefixLine) {
        throw new RangeEditValidationError(
          "ACCIDENTAL_FULL_FILE_IN_RANGE_MODE",
          `Replacement starts with unselected prefix content ("${firstPrefixLine.slice(0, 60)}"). In range mode, supply ONLY the replacement text for the selected range — PatchPilot preserves prefix and suffix automatically.`
        );
      }

      // Check if multiple distinct unselected prefix lines were copied into the replacement
      const prefixLineSet = new Set(prefixLines);
      let prefixOverlap = 0;
      for (const rl of repLines) {
        if (prefixLineSet.has(rl)) {
          prefixOverlap++;
        }
      }
      if (prefixOverlap >= 3 && prefixOverlap >= Math.ceil(prefixLines.length * 0.5)) {
        throw new RangeEditValidationError(
          "ACCIDENTAL_FULL_FILE_IN_RANGE_MODE",
          `Replacement duplicates ${prefixOverlap} unselected lines from before the selection. In range mode, return ONLY the replacement for the selected range.`
        );
      }
    }
  }

  if (suffix.trim().length >= 30 && repLines.length >= 2) {
    const suffixLines = getDistinctNonEmptyLines(suffix).filter((l) => !selectedLineSet.has(l));
    if (suffixLines.length > 0) {
      const lastSuffixLine = suffixLines[suffixLines.length - 1];
      if (repLines[repLines.length - 1] === lastSuffixLine) {
        throw new RangeEditValidationError(
          "ACCIDENTAL_FULL_FILE_IN_RANGE_MODE",
          `Replacement ends with unselected suffix content ("${lastSuffixLine.slice(0, 60)}"). In range mode, supply ONLY the replacement text for the selected range.`
        );
      }

      const suffixLineSet = new Set(suffixLines);
      let suffixOverlap = 0;
      for (const rl of repLines) {
        if (suffixLineSet.has(rl)) {
          suffixOverlap++;
        }
      }
      if (suffixOverlap >= 3) {
        throw new RangeEditValidationError(
          "ACCIDENTAL_FULL_FILE_IN_RANGE_MODE",
          `Replacement duplicates ${suffixOverlap} unselected lines from after the selection. In range mode, return ONLY the replacement for the selected range.`
        );
      }
    }
  }

  // Structural truncation checks when replacing a multi-line function/class definition
  const origTrim = effectiveSelectedText.trim();
  const isCompleteBlockDef =
    /^(?:(?:async\s+)?def\s+|class\s+|(?:export\s+)?(?:async\s+)?function\s+)/.test(origTrim) &&
    origTrim.includes("\n");

  if (isCompleteBlockDef) {
    // Unclosed triple-quoted docstrings
    const origTripleDouble = countNonOverlapping(effectiveSelectedText, '"""');
    const repTripleDouble = countNonOverlapping(replacement, '"""');
    if (origTripleDouble % 2 === 0 && repTripleDouble % 2 !== 0) {
      throw new RangeEditValidationError(
        "TRUNCATED_REPLACEMENT",
        'Replacement appears truncated: unclosed triple-quoted string (""").'
      );
    }

    const origTripleSingle = countNonOverlapping(effectiveSelectedText, "'''");
    const repTripleSingle = countNonOverlapping(replacement, "'''");
    if (origTripleSingle % 2 === 0 && repTripleSingle % 2 !== 0) {
      throw new RangeEditValidationError(
        "TRUNCATED_REPLACEMENT",
        "Replacement appears truncated: unclosed triple-quoted string (''')."
      );
    }

    // Truncated Python def/class signature with no body
    const repNonEmptyLines = replacement
      .replace(/\r\n/g, "\n")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    if (
      /^(?:async\s+)?(?:def|class)\s+/.test(origTrim) &&
      repNonEmptyLines.length === 1 &&
      repNonEmptyLines[0].trim().endsWith(":")
    ) {
      throw new RangeEditValidationError(
        "TRUNCATED_REPLACEMENT",
        "Replacement appears truncated: function/class header has no body."
      );
    }

    // Unbalanced delimiters introduced where original selection was balanced
    const origBal = delimiterBalance(effectiveSelectedText);
    const repBal = delimiterBalance(replacement);
    if (
      origBal.paren === 0 &&
      origBal.bracket === 0 &&
      origBal.brace === 0 &&
      (repBal.paren !== 0 || repBal.bracket !== 0 || repBal.brace !== 0)
    ) {
      throw new RangeEditValidationError(
        "TRUNCATED_REPLACEMENT",
        `Replacement appears truncated or malformed: unbalanced delimiters (paren=${repBal.paren}, bracket=${repBal.bracket}, brace=${repBal.brace}).`
      );
    }
  }
}

/**
 * Reconstructs a full-file proposal from an inline range replacement while strictly enforcing
 * all six preservation invariants (prefix, suffix, staleness, truncation, isolation, expansion).
 */
export function applyRangeReplacement(
  originalFullContent: string,
  context: InlineEditContext,
  input: RangeReplacementInput
): RangeReplacementResult {
  // Invariant 3: Verify file hash matches captured selection baseline
  const actualSha = computeSha256(originalFullContent);
  if (actualSha !== context.originalSha256) {
    throw new RangeEditValidationError(
      "STALE_DOCUMENT",
      `Document "${context.relativePath}" changed after the inline selection was captured (expected SHA-256 ${context.originalSha256.slice(0, 12)}, got ${actualSha.slice(0, 12)}). Start a fresh inline edit.`
    );
  }

  // Re-verify selection coordinates and verbatim selected text
  const verifiedStart = positionToUtf16Offset(originalFullContent, context.range.start);
  const verifiedEnd = positionToUtf16Offset(originalFullContent, context.range.end);
  if (
    verifiedStart !== context.startOffset ||
    verifiedEnd !== context.endOffset ||
    originalFullContent.slice(verifiedStart, verifiedEnd) !== context.selectedText
  ) {
    throw new RangeEditValidationError(
      "SELECTION_MISMATCH",
      `Selection boundaries for "${context.relativePath}" no longer match the captured selection text. Start a fresh inline edit.`
    );
  }

  // Invariant 6: Handle explicit expanded range (only when BOTH expandedRange and expansionReason are given)
  let effectiveRange: ZeroBasedRange = context.range;
  let effectiveStartOffset = context.startOffset;
  let effectiveEndOffset = context.endOffset;
  let isExplicitExpansion = false;

  if (input.expandedRange) {
    const reason = (input.expansionReason || "").trim();
    if (reason.length < 10) {
      throw new RangeEditValidationError(
        "MISSING_EXPANSION_REASON",
        "Expanded range edit requires an explicit 'expansionReason' (at least 10 characters) explaining why lines outside the selection must change."
      );
    }

    const expStart = positionToUtf16Offset(originalFullContent, input.expandedRange.start);
    const expEnd = positionToUtf16Offset(originalFullContent, input.expandedRange.end);
    if (expEnd <= expStart) {
      throw new RangeEditValidationError(
        "INVALID_RANGE",
        "Expanded range must be non-empty (end must be strictly after start)."
      );
    }

    effectiveRange = input.expandedRange;
    effectiveStartOffset = expStart;
    effectiveEndOffset = expEnd;
    isExplicitExpansion =
      expStart < context.startOffset || expEnd > context.endOffset;
  }

  const effectiveSelectedText = originalFullContent.slice(
    effectiveStartOffset,
    effectiveEndOffset
  );
  const prefix = originalFullContent.slice(0, effectiveStartOffset);
  const suffix = originalFullContent.slice(effectiveEndOffset);

  // Invariant 4: Validate replacement fragment
  validateReplacementFragment(input.replacement, effectiveSelectedText, prefix, suffix);

  // Normalize EOLs to match the original file (preserves CRLF vs LF seamlessly)
  let normalizedReplacement = normalizeReplacementEol(input.replacement, context.eol);

  // Preserve exact trailing-newline boundary parity with the replaced slice so adjacent lines
  // are never glued together and spurious blank lines are not injected.
  const eol = context.eol;
  if (effectiveSelectedText.endsWith(eol) && !normalizedReplacement.endsWith(eol)) {
    normalizedReplacement = normalizedReplacement + eol;
  } else if (
    !effectiveSelectedText.endsWith(eol) &&
    normalizedReplacement.endsWith(eol) &&
    !normalizedReplacement.endsWith(eol + eol) &&
    suffix.startsWith(eol)
  ) {
    normalizedReplacement = normalizedReplacement.slice(0, -eol.length);
  }

  // Invariants 1 & 2: Mechanically splice replacement between preserved prefix and suffix
  const reconstructedContent = prefix + normalizedReplacement + suffix;

  // Hard post-condition assertions guaranteeing code-unit-for-code-unit preservation
  const prefixPreserved = reconstructedContent.slice(0, prefix.length) === prefix;
  const suffixPreserved =
    suffix.length === 0 ||
    reconstructedContent.slice(reconstructedContent.length - suffix.length) === suffix;

  if (
    !prefixPreserved ||
    !suffixPreserved ||
    reconstructedContent.length !== prefix.length + normalizedReplacement.length + suffix.length
  ) {
    throw new RangeEditValidationError(
      "PRESERVATION_INVARIANT_FAILED",
      "Internal preservation invariant failure: prefix or suffix did not match verbatim."
    );
  }

  if (reconstructedContent === originalFullContent) {
    throw new RangeEditValidationError(
      "NO_CHANGES",
      `Proposed replacement for "${context.relativePath}" produces no changes from the original selection.`
    );
  }

  // Verify diff containment relative to original user selection
  const expansionReport = detectSelectionExpansion(
    originalFullContent,
    reconstructedContent,
    context.displayStartLine,
    context.displayEndLine
  );

  if (!isExplicitExpansion && expansionReport.expanded) {
    // Double-check at line level: for non-expanded range edits, every changed hunk must fall within
    // the original selection's 1-based line span.
    const zeroCtxHunks = generateDiffHunks(originalFullContent, reconstructedContent, 0);
    const outOfRange = zeroCtxHunks.some((h) => {
      const startLine = Math.max(1, h.oldStart);
      const endLine = h.oldLines > 0 ? h.oldStart + h.oldLines - 1 : startLine;
      return startLine < context.displayStartLine || endLine > context.displayEndLine;
    });
    if (outOfRange) {
      throw new RangeEditValidationError(
        "PRESERVATION_INVARIANT_FAILED",
        `Reconstructed diff modified lines outside selected lines ${context.displayStartLine}-${context.displayEndLine} without an explicit expandedRange.`
      );
    }
  }

  const selectionExpansion = isExplicitExpansion
    ? {
        ...expansionReport,
        expanded: true,
        explicitlyRequested: true,
        reason: `Explicitly requested expanded range edit (${input.expansionReason!.trim()}). Original selection was lines ${context.displayStartLine}-${context.displayEndLine}; review every hunk carefully.`,
      }
    : expansionReport;

  return {
    reconstructedContent,
    normalizedReplacement,
    effectiveRange,
    effectiveStartOffset,
    effectiveEndOffset,
    prefixLength: prefix.length,
    suffixLength: suffix.length,
    prefixPreserved,
    suffixPreserved,
    selectionExpansion,
  };
}
