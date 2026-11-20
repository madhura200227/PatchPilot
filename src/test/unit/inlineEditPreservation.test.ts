import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { applyAcceptedProposals } from "../../workspace/hunkReview";
import {
  createWorkspaceMcpServer,
  RunningWorkspaceMcpServer,
} from "../../workspace/mcpServerCore";
import { computeSha256 } from "../../workspace/patchEngine";
import { ProposalStore } from "../../workspace/proposalStore";
import {
  applyRangeReplacement,
  captureSelectionContext,
  positionToUtf16Offset,
  RangeEditValidationError,
  utf16OffsetToPosition,
} from "../../workspace/rangeEdit";
import { UndoManager } from "../../workspace/undoManager";

/**
 * Generates a deterministic >=641-line Python module modeled after Flask's src/flask/helpers.py
 * with unrelated imports at lines 1-27, get_debug_flag() at lines 28-33, get_load_dotenv() at 36-48,
 * and a second substantive function after line 58 plus filler functions through line 645.
 */
function build645LinePythonFixture(eol: "\n" | "\r\n" = "\n"): string {
  const lines: string[] = [
    "from __future__ import annotations", // 1
    "", // 2
    "import importlib.util", // 3
    "import os", // 4
    "import sys", // 5
    "import typing as t", // 6
    "from datetime import datetime", // 7
    "from functools import cache", // 8
    "from functools import update_wrapper", // 9
    "", // 10
    "# Unrelated imports section preserved verbatim", // 11
    "import json", // 12
    "import mimetypes", // 13
    "import pathlib", // 14
    "import socket", // 15
    "import urllib.parse", // 16
    "import warnings", // 17
    "from collections.abc import Iterable", // 18
    "from collections.abc import Iterator", // 19
    "from dataclasses import dataclass", // 20
    "from email.utils import formatdate", // 21
    "from hashlib import sha256", // 22
    "from io import BytesIO", // 23
    "from pathlib import Path", // 24
    "from weakref import ref", // 25
    "", // 26
    "", // 27
    "def get_debug_flag() -> bool:", // 28
    '    """Get whether debug mode should be enabled for the app, indicated by the', // 29
    '    :envvar:`FLASK_DEBUG` environment variable. The default is ``False``.', // 30
    '    """', // 31
    '    val = os.environ.get("FLASK_DEBUG")', // 32
    '    return bool(val and val.lower() not in {"0", "false", "no"})', // 33
    "", // 34
    "", // 35
    "def get_load_dotenv(default: bool = True) -> bool:", // 36
    '    """Get whether the user has disabled loading default dotenv files."""', // 37
    '    val = os.environ.get("FLASK_SKIP_DOTENV")', // 38
    "    if not val:", // 39
    "        return default", // 40
    '    return val.lower() in ("0", "false", "no")', // 41
    "", // 42
    "", // 43
    "# Spacer lines before second major function after line 58", // 44
    "# spacer 45", // 45
    "# spacer 46", // 46
    "# spacer 47", // 47
    "# spacer 48", // 48
    "# spacer 49", // 49
    "# spacer 50", // 50
    "# spacer 51", // 51
    "# spacer 52", // 52
    "# spacer 53", // 53
    "# spacer 54", // 54
    "# spacer 55", // 55
    "# spacer 56", // 56
    "# spacer 57", // 57
    "", // 58
    "def stream_with_context(generator_or_function):", // 59
    '    """Wrap a response generator function so that it runs inside the current context."""', // 60
    "    return generator_or_function", // 61
    "", // 62
  ];

  // Fill remaining lines past 641 with deterministic unrelated helper functions
  let fnIndex = 1;
  while (lines.length < 645) {
    lines.push(`def unrelated_helper_${fnIndex}(x: int) -> int:`);
    lines.push(`    """Deterministic unrelated helper #${fnIndex}."""`);
    lines.push(`    return x + ${fnIndex}`);
    lines.push("");
    fnIndex++;
  }

  return lines.join(eol) + eol;
}

const TASK_A_REPLACEMENT = [
  "def get_debug_flag() -> bool:",
  '    """Get whether debug mode should be enabled for the app, indicated by the',
  "    :envvar:`FLASK_DEBUG` environment variable. The default is ``False``.",
  "",
  "    Debug mode is disabled when ``FLASK_DEBUG`` is unset, an empty string, or",
  '    one of ``"0"``, ``"false"``, ``"no"``, ``"off"``, or ``"n"``',
  "    (case-insensitive).",
  '    """',
  '    val = os.environ.get("FLASK_DEBUG")',
  '    return bool(val and val.lower() not in {"0", "false", "no", "off", "n"})',
].join("\n");

describe("Regression: Inline Edit Selection Preservation (Prompt 009 — All 20+ Scenarios)", () => {
  let tmpWs: string;

  beforeEach(() => {
    tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "patchpilot-inline-reg-"));
    fs.mkdirSync(path.join(tmpWs, "src", "flask"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  });

  it("1, 15, 16. Complete Python function on a 645-line fixture preserves imports, prefix, suffix, and second function with a small localized diff", async () => {
    const content = build645LinePythonFixture("\n");
    const lineCount = content.split("\n").length - 1;
    assert.ok(lineCount >= 641, `Fixture must have >= 641 lines, got ${lineCount}`);

    const filePath = path.join(tmpWs, "src", "flask", "helpers.py");
    fs.writeFileSync(filePath, content, "utf8");
    const originalSha = computeSha256(content);

    // Select lines 28-33 (0-based line 27 col 0 -> line 32 end of line)
    const lines = content.split("\n");
    const ctx = captureSelectionContext(
      "src/flask/helpers.py",
      content,
      {
        start: { line: 27, character: 0 },
        end: { line: 32, character: lines[32].length },
      },
      1
    );

    assert.strictEqual(ctx.displayStartLine, 28);
    assert.strictEqual(ctx.displayEndLine, 33);
    assert.ok(ctx.selectedText.startsWith("def get_debug_flag() -> bool:"));
    assert.ok(ctx.selectedText.endsWith('not in {"0", "false", "no"})'));

    const store = new ProposalStore(tmpWs);
    try {
      store.setActiveRun("run-inline-1", undefined, ctx);

      const created = await store.createOrUpdateProposal({
        relativePath: "src/flask/helpers.py",
        mode: "range",
        replacement: TASK_A_REPLACEMENT,
        summary: "Treat 'off' and 'n' as false in get_debug_flag and update docstring",
      });

      const prop = created.proposal;
      assert.strictEqual(prop.editMode, "range");
      assert.strictEqual(prop.prefixPreserved, true);
      assert.strictEqual(prop.suffixPreserved, true);

      // Exact byte-for-byte prefix & suffix preservation
      const origPrefix = content.slice(0, ctx.startOffset);
      const origSuffix = content.slice(ctx.endOffset);
      assert.strictEqual(prop.proposedContent.slice(0, origPrefix.length), origPrefix);
      assert.strictEqual(
        prop.proposedContent.slice(prop.proposedContent.length - origSuffix.length),
        origSuffix
      );

      // Unrelated imports and second function after line 58 remain identical
      assert.ok(prop.proposedContent.includes("from __future__ import annotations"));
      assert.ok(prop.proposedContent.includes("def stream_with_context(generator_or_function):"));
      assert.ok(prop.proposedContent.includes("def unrelated_helper_100(x: int) -> int:"));

      // Diff must be small and localized — NEVER -581 or -635 deleted lines!
      assert.strictEqual(prop.hunks.length, 1);
      assert.ok(created.removedLines <= 5, `Expected <= 5 removed lines, got ${created.removedLines}`);
      assert.ok(created.addedLines <= 12, `Expected <= 12 added lines, got ${created.addedLines}`);
      assert.strictEqual(prop.selectionExpansion?.expanded, false);

      // Host file on disk must remain 100% untouched (Invariant 5)
      assert.strictEqual(computeSha256(fs.readFileSync(filePath, "utf8")), originalSha);
    } finally {
      store.cleanup();
    }
  });

  it("2. Selection of a partial function body preserves function signature, docstring, and rest of file", () => {
    const content = build645LinePythonFixture("\n");
    const lines = content.split("\n");
    // Select ONLY line 33 (0-based line 32)
    const ctx = captureSelectionContext(
      "src/flask/helpers.py",
      content,
      {
        start: { line: 32, character: 4 },
        end: { line: 32, character: lines[32].length },
      },
      1
    );

    const res = applyRangeReplacement(content, ctx, {
      replacement: 'return bool(val and val.lower() not in {"0", "false", "no", "off", "n"})',
    });

    assert.strictEqual(res.prefixPreserved, true);
    assert.strictEqual(res.suffixPreserved, true);
    assert.ok(res.reconstructedContent.includes('    return bool(val and val.lower() not in {"0", "false", "no", "off", "n"})'));
    assert.strictEqual(res.reconstructedContent.slice(0, ctx.startOffset), content.slice(0, ctx.startOffset));
    assert.strictEqual(
      res.reconstructedContent.slice(res.reconstructedContent.length - (content.length - ctx.endOffset)),
      content.slice(ctx.endOffset)
    );
  });

  it("3. Selection spanning multiple lines with partial start/end columns preserves surrounding characters on boundary lines", () => {
    const content = "alpha = (1 +\n    2 +\n    3)\nbeta = 99\n";
    const ctx = captureSelectionContext(
      "src/expr.py",
      content,
      {
        start: { line: 0, character: 9 }, // starts right at "1 +"
        end: { line: 2, character: 5 }, // ends right after "    3" (before ")")
      },
      1
    );
    assert.strictEqual(ctx.selectedText, "1 +\n    2 +\n    3");

    const res = applyRangeReplacement(content, ctx, {
      replacement: "10 +\n    20 +\n    30",
    });

    assert.strictEqual(res.reconstructedContent, "alpha = (10 +\n    20 +\n    30)\nbeta = 99\n");
    assert.strictEqual(res.prefixPreserved, true);
    assert.strictEqual(res.suffixPreserved, true);
  });

  it("4. Selection at the beginning of a file preserves the entire suffix", () => {
    const content = "HEADER_V1 = 1\n\ndef keep_me():\n    return True\n";
    const ctx = captureSelectionContext(
      "src/top.py",
      content,
      { start: { line: 0, character: 0 }, end: { line: 0, character: 13 } },
      1
    );
    assert.strictEqual(ctx.startOffset, 0);

    const res = applyRangeReplacement(content, ctx, { replacement: "HEADER_V2 = 2" });
    assert.strictEqual(res.reconstructedContent, "HEADER_V2 = 2\n\ndef keep_me():\n    return True\n");
    assert.strictEqual(res.prefixLength, 0);
    assert.strictEqual(res.suffixPreserved, true);
  });

  it("5. Selection at the end of a file preserves the entire prefix", () => {
    const content = "def first():\n    return 1\n\ndef last():\n    return 2";
    const ctx = captureSelectionContext(
      "src/end.py",
      content,
      { start: { line: 3, character: 0 }, end: { line: 4, character: 12 } },
      1
    );
    assert.strictEqual(ctx.endOffset, content.length);

    const res = applyRangeReplacement(content, ctx, {
      replacement: "def last():\n    return 200",
    });
    assert.strictEqual(
      res.reconstructedContent,
      "def first():\n    return 1\n\ndef last():\n    return 200"
    );
    assert.strictEqual(res.suffixLength, 0);
    assert.strictEqual(res.prefixPreserved, true);
  });

  it("6 & 7. CRLF and LF line endings are both preserved accurately without spurious whole-file EOL churn", () => {
    const crlfContent = build645LinePythonFixture("\r\n");
    const crlfLines = crlfContent.split("\r\n");
    const crlfCtx = captureSelectionContext(
      "src/flask/helpers.py",
      crlfContent,
      { start: { line: 27, character: 0 }, end: { line: 32, character: crlfLines[32].length } },
      1
    );
    assert.strictEqual(crlfCtx.eol, "\r\n");

    // Supply LF replacement into CRLF file — engine normalizes replacement EOLs to CRLF
    const crlfRes = applyRangeReplacement(crlfContent, crlfCtx, {
      replacement: TASK_A_REPLACEMENT,
    });
    assert.strictEqual(crlfRes.prefixPreserved, true);
    assert.strictEqual(crlfRes.suffixPreserved, true);
    assert.ok(!crlfRes.reconstructedContent.replace(/\r\n/g, "").includes("\n"), "All newlines must remain CRLF");

    // LF file stays pure LF even if model passes CRLF
    const lfContent = build645LinePythonFixture("\n");
    const lfLines = lfContent.split("\n");
    const lfCtx = captureSelectionContext(
      "src/flask/helpers.py",
      lfContent,
      { start: { line: 27, character: 0 }, end: { line: 32, character: lfLines[32].length } },
      1
    );
    assert.strictEqual(lfCtx.eol, "\n");
    const lfRes = applyRangeReplacement(lfContent, lfCtx, {
      replacement: TASK_A_REPLACEMENT.replace(/\n/g, "\r\n"),
    });
    assert.ok(!lfRes.reconstructedContent.includes("\r\n"), "LF file must remain pure LF");
  });

  it("8. Unicode characters (emojis/surrogate pairs, accents, CJK) before and inside selection maintain exact UTF-16 offsets", () => {
    const content = [
      '# Prefix comment: café 🚀🔥 日本語 — exact UTF-16 test',
      'GREETING = "こんにちは 🚀"',
      'def greet(name: str) -> str:',
      '    return f"Héllo 🚀 {name}"',
      'TAIL = "end — café 🎉"',
      "",
    ].join("\n");

    // Select inside line 3 after '    return ' (UTF-16 character 11 to end of line)
    const lines = content.split("\n");
    const posStart = { line: 3, character: 11 };
    const posEnd = { line: 3, character: lines[3].length };
    const offStart = positionToUtf16Offset(content, posStart);
    const offEnd = positionToUtf16Offset(content, posEnd);

    assert.deepStrictEqual(utf16OffsetToPosition(content, offStart), posStart);
    assert.deepStrictEqual(utf16OffsetToPosition(content, offEnd), posEnd);

    const ctx = captureSelectionContext("src/unicode.py", content, { start: posStart, end: posEnd }, 1);
    assert.strictEqual(ctx.selectedText, 'f"Héllo 🚀 {name}"');

    const res = applyRangeReplacement(content, ctx, {
      replacement: 'f"Welcome 🌟 {name} (日本語)"',
    });

    assert.strictEqual(res.prefixPreserved, true);
    assert.strictEqual(res.suffixPreserved, true);
    assert.ok(res.reconstructedContent.includes('# Prefix comment: café 🚀🔥 日本語 — exact UTF-16 test'));
    assert.ok(res.reconstructedContent.includes('    return f"Welcome 🌟 {name} (日本語)"'));
    assert.ok(res.reconstructedContent.includes('TAIL = "end — café 🎉"'));
  });

  it("9. Multiple occurrences of identical selected text modifies ONLY the selected occurrence", () => {
    const content = [
      "def one():",
      "    return 0",
      "",
      "def two():",
      "    return 0",
      "",
      "def three():",
      "    return 0",
      "",
    ].join("\n");

    // Select ONLY the second "    return 0" (line 4, 0-based)
    const ctx = captureSelectionContext(
      "src/dups.py",
      content,
      { start: { line: 4, character: 0 }, end: { line: 4, character: 12 } },
      1
    );
    assert.strictEqual(ctx.selectedText, "    return 0");

    const res = applyRangeReplacement(content, ctx, { replacement: "    return 2" });
    assert.strictEqual(
      res.reconstructedContent,
      ["def one():", "    return 0", "", "def two():", "    return 2", "", "def three():", "    return 0", ""].join("\n")
    );
  });

  it("10. Stale file content after selection capture is rejected with STALE_DOCUMENT", async () => {
    const content = build645LinePythonFixture("\n");
    const filePath = path.join(tmpWs, "src", "flask", "helpers.py");
    fs.writeFileSync(filePath, content, "utf8");

    const lines = content.split("\n");
    const ctx = captureSelectionContext(
      "src/flask/helpers.py",
      content,
      { start: { line: 27, character: 0 }, end: { line: 32, character: lines[32].length } },
      1
    );

    // Simulate external file edit after selection capture
    fs.writeFileSync(filePath, "# external concurrent edit\n" + content, "utf8");

    const store = new ProposalStore(tmpWs);
    try {
      store.setActiveRun("run-stale", undefined, ctx);
      await assert.rejects(
        () =>
          store.createOrUpdateProposal({
            relativePath: "src/flask/helpers.py",
            mode: "range",
            replacement: TASK_A_REPLACEMENT,
          }),
        (err: unknown) =>
          err instanceof RangeEditValidationError && err.code === "STALE_DOCUMENT"
      );
      assert.strictEqual(store.listProposals().length, 0);
    } finally {
      store.cleanup();
    }
  });

  it("11 & 12. Truncated, malformed, and empty replacements are rejected safely", () => {
    const content = build645LinePythonFixture("\n");
    const lines = content.split("\n");
    const ctx = captureSelectionContext(
      "src/flask/helpers.py",
      content,
      { start: { line: 27, character: 0 }, end: { line: 32, character: lines[32].length } },
      1
    );

    // Empty replacement (#12)
    assert.throws(
      () => applyRangeReplacement(content, ctx, { replacement: "   \n  " }),
      (err: unknown) =>
        err instanceof RangeEditValidationError && err.code === "EMPTY_REPLACEMENT"
    );

    // Markdown fenced replacement
    assert.throws(
      () =>
        applyRangeReplacement(content, ctx, {
          replacement: "```python\n" + TASK_A_REPLACEMENT + "\n```",
        }),
      (err: unknown) =>
        err instanceof RangeEditValidationError && err.code === "MALFORMED_REPLACEMENT"
    );

    // Truncated unclosed docstring (#11)
    assert.throws(
      () =>
        applyRangeReplacement(content, ctx, {
          replacement: 'def get_debug_flag() -> bool:\n    """Unclosed docstring cut off mid-stream',
        }),
      (err: unknown) =>
        err instanceof RangeEditValidationError && err.code === "TRUNCATED_REPLACEMENT"
    );

    // Truncated header with no body (#11)
    assert.throws(
      () =>
        applyRangeReplacement(content, ctx, {
          replacement: "def get_debug_flag() -> bool:",
        }),
      (err: unknown) =>
        err instanceof RangeEditValidationError && err.code === "TRUNCATED_REPLACEMENT"
    );

    // Truncation placeholder comment (#11)
    assert.throws(
      () =>
        applyRangeReplacement(content, ctx, {
          replacement: "def get_debug_flag() -> bool:\n    # ... rest of file unchanged\n    return False",
        }),
      (err: unknown) =>
        err instanceof RangeEditValidationError && err.code === "TRUNCATED_REPLACEMENT"
    );
  });

  it("13. Accidental full-file replacement in range-edit mode (both Attempt 1 & Attempt 2 failure shapes) is rejected", async () => {
    const content = build645LinePythonFixture("\n");
    const filePath = path.join(tmpWs, "src", "flask", "helpers.py");
    fs.writeFileSync(filePath, content, "utf8");

    const lines = content.split("\n");
    const ctx = captureSelectionContext(
      "src/flask/helpers.py",
      content,
      { start: { line: 27, character: 0 }, end: { line: 32, character: lines[32].length } },
      1
    );

    const store = new ProposalStore(tmpWs);
    try {
      store.setActiveRun("run-accidental-full", undefined, ctx);

      // Failure shape from Attempt 2: model calls full_file with only the 10-line function fragment
      await assert.rejects(
        () =>
          store.createOrUpdateProposal({
            relativePath: "src/flask/helpers.py",
            mode: "full_file",
            content: TASK_A_REPLACEMENT,
          }),
        (err: unknown) =>
          err instanceof RangeEditValidationError && err.code === "FULL_FILE_REJECTED_IN_INLINE_EDIT"
      );

      // Failure shape from Attempt 1: model puts lines 1..58 (including unselected prefix imports) into mode="range" replacement
      const truncatedTop60Lines = lines.slice(0, 27).join("\n") + "\n" + TASK_A_REPLACEMENT + "\n" + lines.slice(33, 58).join("\n");
      await assert.rejects(
        () =>
          store.createOrUpdateProposal({
            relativePath: "src/flask/helpers.py",
            mode: "range",
            replacement: truncatedTop60Lines,
          }),
        (err: unknown) =>
          err instanceof RangeEditValidationError && err.code === "ACCIDENTAL_FULL_FILE_IN_RANGE_MODE"
      );

      // Zero proposals stored from either bad attempt
      assert.strictEqual(store.listProposals().length, 0);
    } finally {
      store.cleanup();
    }
  });

  it("14. Legitimate full-file edit in Agent Mode continues to work cleanly", async () => {
    const filePath = path.join(tmpWs, "src", "flask", "cli.py");
    fs.writeFileSync(filePath, "def old_cmd():\n    return 1\n", "utf8");

    const store = new ProposalStore(tmpWs);
    try {
      store.setActiveRun("run-agent-mode", null, null);
      const created = await store.createOrUpdateProposal({
        relativePath: "src/flask/cli.py",
        mode: "full_file",
        content: "def old_cmd():\n    return 1\n\ndef config_command():\n    return '{}'\n",
        summary: "Add config_command in Agent Mode",
      });
      assert.strictEqual(created.proposal.editMode, "full_file");
      assert.strictEqual(created.proposal.hunks.length, 1);
    } finally {
      store.cleanup();
    }
  });

  it("17. Explicit expanded range requires expansionReason, preserves outer prefix/suffix, and sets selectionExpansion warning", async () => {
    const content = build645LinePythonFixture("\n");
    const filePath = path.join(tmpWs, "src", "flask", "helpers.py");
    fs.writeFileSync(filePath, content, "utf8");
    const lines = content.split("\n");

    const ctx = captureSelectionContext(
      "src/flask/helpers.py",
      content,
      { start: { line: 27, character: 0 }, end: { line: 32, character: lines[32].length } },
      1
    );

    const expandedRange = {
      start: { line: 27, character: 0 },
      end: { line: 40, character: lines[40].length },
    };

    const store = new ProposalStore(tmpWs);
    try {
      store.setActiveRun("run-expand", undefined, ctx);

      // Missing expansionReason must be rejected
      await assert.rejects(
        () =>
          store.createOrUpdateProposal({
            relativePath: "src/flask/helpers.py",
            mode: "range",
            replacement: TASK_A_REPLACEMENT + "\n\n\ndef get_load_dotenv(default: bool = True) -> bool:\n    return default",
            expandedRange,
          }),
        (err: unknown) =>
          err instanceof RangeEditValidationError && err.code === "MISSING_EXPANSION_REASON"
      );

      // With explicit expansionReason: succeeds, preserves lines 1-27 AND lines 42-645, and warns user!
      const expandedText =
        TASK_A_REPLACEMENT +
        "\n\n\n" +
        lines.slice(35, 40).join("\n") +
        '\n    return val.lower() in ("0", "false", "no", "off", "n")';

      const created = await store.createOrUpdateProposal({
        relativePath: "src/flask/helpers.py",
        mode: "range",
        replacement: expandedText,
        expandedRange,
        expansionReason: "Also align get_load_dotenv false values with get_debug_flag.",
      });

      assert.strictEqual(created.proposal.prefixPreserved, true);
      assert.strictEqual(created.proposal.suffixPreserved, true);
      assert.strictEqual(created.proposal.selectionExpansion?.expanded, true);
      assert.strictEqual(created.proposal.selectionExpansion?.explicitlyRequested, true);
      assert.ok(created.proposal.selectionExpansion?.reason?.includes("align get_load_dotenv"));
      assert.ok(created.proposal.proposedContent.includes("def stream_with_context(generator_or_function):"));
      assert.ok(created.proposal.proposedContent.includes("def unrelated_helper_100(x: int) -> int:"));
    } finally {
      store.cleanup();
    }
  });

  it("18, 19, 20. Rejecting all hunks leaves workspace unchanged; applying accepted hunks updates only target; Undo restores exact 645-line original", async () => {
    const content = build645LinePythonFixture("\n");
    const filePath = path.join(tmpWs, "src", "flask", "helpers.py");
    fs.writeFileSync(filePath, content, "utf8");
    const originalSha = computeSha256(content);
    const lines = content.split("\n");

    const ctx = captureSelectionContext(
      "src/flask/helpers.py",
      content,
      { start: { line: 27, character: 0 }, end: { line: 32, character: lines[32].length } },
      1
    );

    const store = new ProposalStore(tmpWs);
    const undo = new UndoManager();

    try {
      store.setActiveRun("run-apply-undo", undefined, ctx);
      const created = await store.createOrUpdateProposal({
        relativePath: "src/flask/helpers.py",
        mode: "range",
        replacement: TASK_A_REPLACEMENT,
      });

      // #18: Reject all hunks -> apply does nothing and workspace stays untouched
      store.setAllHunksDecision(created.proposal.proposalId, "rejected");
      const noopRes = await applyAcceptedProposals(tmpWs, store, undo);
      assert.strictEqual(noopRes.appliedFiles.length, 0);
      assert.strictEqual(computeSha256(fs.readFileSync(filePath, "utf8")), originalSha);

      // #19: Accept hunk -> apply updates ONLY get_debug_flag while preserving all 645 lines around it
      store.setHunkDecision(created.proposal.proposalId, created.proposal.hunks[0].id, "accepted");
      const applyRes = await applyAcceptedProposals(tmpWs, store, undo);
      assert.strictEqual(applyRes.appliedFiles.length, 1);

      const diskAfterApply = fs.readFileSync(filePath, "utf8");
      assert.ok(diskAfterApply.includes('not in {"0", "false", "no", "off", "n"}'));
      assert.ok(diskAfterApply.includes("def stream_with_context(generator_or_function):"));
      assert.ok(diskAfterApply.includes("def unrelated_helper_100(x: int) -> int:"));
      assert.strictEqual(diskAfterApply.slice(0, ctx.startOffset), content.slice(0, ctx.startOffset));
      assert.strictEqual(
        diskAfterApply.slice(diskAfterApply.length - (content.length - ctx.endOffset)),
        content.slice(ctx.endOffset)
      );

      // #20: Undo restores exact byte-for-byte 645-line original file!
      const undoRes = await undo.undoLastApply();
      assert.strictEqual(undoRes.success, true);
      assert.strictEqual(computeSha256(fs.readFileSync(filePath, "utf8")), originalSha);
    } finally {
      store.cleanup();
    }
  });

  it("21. Real Streamable HTTP MCP propose_edit enforces mode='range' over the wire and blocks full_file during inline edit", async () => {
    const content = build645LinePythonFixture("\n");
    const filePath = path.join(tmpWs, "src", "flask", "helpers.py");
    fs.writeFileSync(filePath, content, "utf8");
    const lines = content.split("\n");
    const ctx = captureSelectionContext(
      "src/flask/helpers.py",
      content,
      { start: { line: 27, character: 0 }, end: { line: 32, character: lines[32].length } },
      1
    );

    const authToken = "sec-patchpilot-range-mcp-test-1234567890";
    let server: RunningWorkspaceMcpServer | null = null;

    try {
      server = await createWorkspaceMcpServer({
        host: "127.0.0.1",
        port: 0,
        authToken,
        workspaceRoot: tmpWs,
      });

      // Set active inline-edit context via authenticated /control/run
      const ctrlResp = await fetch(`${server.controlBaseUrl}/control/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ runId: "run-mcp-inline", inlineEditContext: ctx }),
      });
      assert.strictEqual(ctrlResp.status, 200);

      const client = new Client({ name: "range-mcp-client", version: "1.0.0" }, { capabilities: {} });
      const transport = new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { Authorization: `Bearer ${authToken}` } },
      });
      await client.connect(transport);

      // Attempt 2 over MCP: full_file during active inline edit must return isError=true
      const badCall = await client.callTool({
        name: "propose_edit",
        arguments: {
          path: "src/flask/helpers.py",
          mode: "full_file",
          content: TASK_A_REPLACEMENT,
        },
      });
      assert.strictEqual(badCall.isError, true);
      const badText = (badCall.content as Array<{ text: string }>)[0].text;
      assert.ok(badText.includes('mode="range"'));

      // Proper mode="range" over MCP must succeed with preserved prefix/suffix and small diff!
      const goodCall = await client.callTool({
        name: "propose_edit",
        arguments: {
          path: "src/flask/helpers.py",
          mode: "range",
          replacement: TASK_A_REPLACEMENT,
          summary: "Update get_debug_flag false values and docstring",
        },
      });
      assert.ok(!goodCall.isError, `Expected range propose_edit to succeed, got: ${JSON.stringify(goodCall)}`);
      const goodJson = JSON.parse((goodCall.content as Array<{ text: string }>)[0].text) as {
        editMode: string;
        hunkCount: number;
        removedLines: number;
        prefixPreserved: boolean;
        suffixPreserved: boolean;
      };
      assert.strictEqual(goodJson.editMode, "range");
      assert.strictEqual(goodJson.hunkCount, 1);
      assert.strictEqual(goodJson.prefixPreserved, true);
      assert.strictEqual(goodJson.suffixPreserved, true);
      assert.ok(goodJson.removedLines <= 5);

      await client.close();
    } finally {
      if (server) {
        await server.stop();
        server.proposalStore.cleanup();
      }
    }
  });
});
