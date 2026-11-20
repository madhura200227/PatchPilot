# PatchPilot — Inline Edit Selection Preservation Bug Fix (Prompt 009)

**Branch:** `fix/inline-edit-selection-preservation`  
**Base `main` SHA:** `8bb5e3d0b3c2e24e27dc834dfdd0f91d10e9dbd2`  
**Affected Workflow:** Inline Edit (`Ctrl+Shift+I` / `Cmd+Shift+I` -> `patchpilot.inlineEdit`)  
**Reproduced On:** `pallets/flask` 3.1.3 (`22d92470`), `src/flask/helpers.py` (641 lines), selecting `get_debug_flag()` (lines 28–33)

---

## 1. Exact Root Cause

Tracing the full 12-step inline-edit pipeline across `PatchPilotController.ts`, `mcpServerCore.ts`, `proposalStore.ts`, `patchEngine.ts`, and `agents/patchpilot.agent.json` exposed **three compounding architectural defects**:

1. **Forced Full-File Reconstruction for a 6-Line Selection (`PatchPilotController.ts` + `mcpServerCore.ts`):**
   - `propose_edit` only accepted `{ path, content, summary }`, unconditionally treating `content` as the **entire replacement file**.
   - `PatchPilotController.runInlineEdit()` sent the model only lines 28–33 plus ±15 lines of surrounding context (lines ~13–48 of a 641-line file), yet instructed the model to *"call propose_edit with the complete updated file content"*.
   - **Why Attempt 1 produced `@@ -58,584 +60,3 @@ (+0 / -581)`:** The model combined the top ~58 lines of `helpers.py` from context / a partial read slice and passed those ~60 lines as `propose_edit.content`, truncating lines 58–641 (581 unrelated lines deleted).
   - **Why Attempt 2 produced `@@ -1,641 +1,16 @@ (+10 / -635)`:** The model passed only the ~16-line modified `get_debug_flag()` function as `propose_edit.content`; `ProposalStore` diffed those 16 lines against the full 641-line file, proposing deletion of 635 unrelated lines.
2. **Line-Only Coordinates & Passive Advisory Warning (`PatchPilotController.ts` + `proposalStore.ts`):**
   - Selection capture recorded only 1-based `{ startLine, endLine }` (no zero-based UTF-16 `start`/`end` character positions or string offsets, no `doc.isDirty` check before hashing, and selection text was read *after* `showInputBox` returned).
   - `ProposalStore` attached `detectSelectionExpansion()` only as a passive UI warning *after* accepting destructive full-file deletions, instead of enforcing range-edit splicing and hard validation invariants.
3. **Ambiguous Agent Instructions (`agents/patchpilot.agent.json` + `src/trueforge/agentManager.ts`):**
   - Agent instructions did not differentiate explicit `mode: "range"` vs `mode: "full_file"` contracts on `propose_edit`.

---

## 2. Affected Components & Before/After Design

| Component | Before (Defective) | After (Fixed) |
|---|---|---|
| [src/workspace/rangeEdit.ts](file:///d:/Projects/PatchPilot/src/workspace/rangeEdit.ts) | *(Did not exist)* | Dedicated range-edit engine: zero-based UTF-16 position/offset math, CRLF/LF preservation, `captureSelectionContext()`, and `applyRangeReplacement()` enforcing Invariants 1–6. |
| [src/workspace/proposalStore.ts](file:///d:/Projects/PatchPilot/src/workspace/proposalStore.ts) | Treated every `propose_edit` payload as a full-file replacement; passive expansion warning only. | Enforces explicit `editMode: "range" \| "full_file"`. Hard-rejects `mode: "full_file"` whenever an `InlineEditContext` is active for the target file (`FULL_FILE_REJECTED_IN_INLINE_EDIT`). Mechanically splices `prefix + normalizedReplacement + suffix` for `mode: "range"`. |
| [src/workspace/mcpServerCore.ts](file:///d:/Projects/PatchPilot/src/workspace/mcpServerCore.ts) | `propose_edit` accepted only `{ path, content, summary }`; `/control/run` accepted only `{ startLine, endLine }`. | `propose_edit` exposes explicit `mode`, `replacement`, `content`, `expandedRange`, `expansionReason`, and `summary`; `/control/run` carries full `InlineEditContext`; responses report `editMode`, `prefixPreserved`, `suffixPreserved`. |
| [src/workspace/WorkspaceProcessManager.ts](file:///d:/Projects/PatchPilot/src/workspace/WorkspaceProcessManager.ts) & [src/workspace/WorkspaceMcpAdapter.ts](file:///d:/Projects/PatchPilot/src/workspace/WorkspaceMcpAdapter.ts) | Forwarded line-only `InlineSelectionConstraint`. | Forwards full hash-anchored `InlineEditContext` to the out-of-process MCP server and extension `ProposalStore`. |
| [src/controller/PatchPilotController.ts](file:///d:/Projects/PatchPilot/src/controller/PatchPilotController.ts) | Captured selection after `showInputBox`; prompted TrueForge to return complete file content. | Checks `doc.isDirty` (Save & Continue), captures immutable `InlineEditContext` before `showInputBox`, verifies `doc.version` & SHA-256 after prompt entry, and instructs TrueForge to use `propose_edit(mode="range", replacement=...)`. |
| [agents/patchpilot.agent.json](file:///d:/Projects/PatchPilot/agents/patchpilot.agent.json) & [src/trueforge/agentManager.ts](file:///d:/Projects/PatchPilot/src/trueforge/agentManager.ts) | Single full-file `propose_edit` rule. | Explicit tool contract distinguishing `mode="range"` (`replacement` only + optional `expandedRange` + `expansionReason`) vs `mode="full_file"` (Agent Mode / new files). |
| [src/ui/ReviewPanelProvider.ts](file:///d:/Projects/PatchPilot/src/ui/ReviewPanelProvider.ts) | Generic `MODIFIED` badge. | Displays `RANGE EDIT` / `FULL-FILE EDIT` and `PREFIX/SUFFIX PRESERVED` badges plus explicit `Selection Expansion Notice` with expansion reason when expanded. |

---

## 3. Selection Coordinate Conventions

PatchPilot uses **zero-based UTF-16 code-unit coordinates** throughout `src/workspace/rangeEdit.ts`, matching VS Code's `vscode.Position`, `vscode.Range`, `TextDocument.offsetAt()`, and JavaScript string indexing (`string.slice(startOffset, endOffset)`):

- `ZeroBasedPosition`: `{ line: number, character: number }` (both 0-based; `character` counts UTF-16 code units, matching surrogate pairs like emojis `🚀` identically to VS Code).
- `startOffset` / `endOffset`: Exact UTF-16 indices in the original file string, verified via `positionToUtf16Offset()` and `utf16OffsetToPosition()`.
- **Line endings:** `\r\n` (CRLF) and `\n` (LF) are indexed accurately without splitting `\r\n`; `normalizeReplacementEol()` matches replacement newlines to the original file's EOL style, and trailing-newline boundary parity prevents glued lines or spurious blank lines.
- **Disambiguation:** Because splicing uses exact `(startOffset, endOffset)` rather than string search/replace, duplicate occurrences of identical text elsewhere in the file are never touched.

---

## 4. Mandatory Preservation Invariants Enforced

All six invariants are hard-enforced before any proposal is stored:

1. **Invariant 1 — Preserve Prefix:** `reconstructed.slice(0, prefix.length) === prefix` asserted verbatim after splicing.
2. **Invariant 2 — Preserve Suffix:** `reconstructed.slice(reconstructed.length - suffix.length) === suffix` asserted verbatim after splicing.
3. **Invariant 3 — Stale Document Protection:** Full-file SHA-256 (`originalSha256`), `positionToUtf16Offset` bounds, and verbatim `originalContent.slice(startOffset, endOffset) === selectedText` are re-verified on disk (`STALE_DOCUMENT` / `SELECTION_MISMATCH`).
4. **Invariant 4 — Reject Truncated / Empty / Malformed / Accidental Full-File Replacements:**
   - Rejects empty/whitespace-only replacements (`EMPTY_REPLACEMENT`).
   - Rejects markdown code-fence wrappers (`MALFORMED_REPLACEMENT`).
   - Rejects truncation placeholders (`... rest of file ...`), unclosed triple-quoted docstrings, bodyless `def`/`class` headers, and newly introduced unbalanced delimiters (`TRUNCATED_REPLACEMENT`).
   - Rejects `mode: "full_file"` during an active inline edit (`FULL_FILE_REJECTED_IN_INLINE_EDIT`) and detects unselected prefix/suffix duplication pasted inside `mode: "range"` `replacement` (`ACCIDENTAL_FULL_FILE_IN_RANGE_MODE`).
5. **Invariant 5 — Review Boundary:** Proposals remain strictly in isolated temporary storage (`%TEMP%/patchpilot-proposals/...`); zero workspace writes occur during generation or review.
6. **Invariant 6 — Explicit Expanded Edits:** Modifying lines outside the original selection requires BOTH `expandedRange` (valid 0-based range) AND `expansionReason` (>=10 chars; otherwise `MISSING_EXPANSION_REASON`). Content outside `expandedRange` is still mechanically preserved, and the Review UI highlights the explicit expansion notice.

---

## 5. Regression & Verification Results

### 5.1 Static Checks, Packaging & Automated Test Suites

| Verification Suite | Command | Result |
|---|---|---|
| TypeScript Lint (`tsc --noEmit`) | `npm run lint` | **PASS** (0 errors) |
| Production Bundle & Compile (`dist/extension.js`, `dist/mcpServer.js`) | `npm run compile` | **PASS** (`dist/extension.js` 1.4 MB, `dist/mcpServer.js` 714 KB) |
| Unit & Inline-Edit Preservation Regression Suite | `npm run test:unit` | **78 passing, 0 failing** (includes all 20 required Prompt 009 regression scenarios + #21 real Streamable HTTP MCP wire test in [inlineEditPreservation.test.ts](file:///d:/Projects/PatchPilot/src/test/unit/inlineEditPreservation.test.ts), plus TrueForge shared-ID delta-merge & deferred `call_tool` unwrapping test in [trueforgeMvp.test.ts](file:///d:/Projects/PatchPilot/src/test/unit/trueforgeMvp.test.ts)) |
| Real VS Code Extension Development Host E2E Suite | `npm run test:vscode` | **7 passing, 0 failing** (Exit code 0 on VS Code `1.146.0`, including test `5b`: range-edit prefix/suffix preservation, `full_file` rejection during active inline edit, `WorkspaceEdit` apply, and `undoLastApply`) |
| VSIX Extension Packaging | `npm run package` | **PASS** (verified clean VSIX packaging) |

### 5.2 Additional Live TrueForge Streaming Bug Found & Fixed During Live Acceptance

During live model-backed testing against TrueForge v0.185.1 (`http://127.0.0.1:8790`) with `preload: false`, two additional protocol bugs were uncovered and fixed in [src/trueforge/turnStream.ts](file:///d:/Projects/PatchPilot/src/trueforge/turnStream.ts) and [src/trueforge/eventTypes.ts](file:///d:/Projects/PatchPilot/src/trueforge/eventTypes.ts):

1. **Shared-ID `model.message.delta` Drops:** TrueForge emits a base `model.message` event followed by `model.message.delta` chunks sharing the **same `id`**. Previously, `seenEventIds` dropped every delta after the base message. Fixed by exempting `model.message.delta` from `seenEventIds` and merging delta fragments into `messageBaseById` via `@truefoundry/trueforge-sdk`'s `mergeEventDelta()`.
2. **Deferred `call_tool` Unwrapping:** Under `preload: false`, TrueForge wraps MCP calls inside system tool `call_tool` with `{ mcp_server, tool_name, input }`. `classifyTurnEvent()` now unwraps `tool_name` (`propose_edit`, `run_workspace_command`, etc.) and its `input` payload so tool timelines and human approval prompts display the true MCP tool name and arguments.

### 5.3 Live Model-Backed Official Forge-a-thon Task A Acceptance Test

Executed [src/test/integration/taskAInlineEditLive.test.ts](file:///d:/Projects/PatchPilot/src/test/integration/taskAInlineEditLive.test.ts) against the real local TrueForge server (`http://127.0.0.1:8790`) and the untouched `pallets/flask` 3.1.3 benchmark (`%TEMP%\patchpilot-flask-benchmark`, `src/flask/helpers.py`, 641 lines, CRLF `\r\n`):

- **Configured Live Model:** `google-gemini/gemini-flash-lite-latest` (selected from TrueForge's live `models.list()`; note: `google-gemini/gemini-3-1-flash-lite` also successfully generated `mode="range"` proposals `prop-3ccb2540eec4` and `prop-7c52d34f054e` with `prefixPreserved=true` / `suffixPreserved=true`, though upstream Gemini API experienced intermittent ~50s `Headers Timeout Error` on subsequent summary calls).
- **Live TrueForge Session ID:** `01m7wn57f2y6182hqp4kvzq1wh`
- **Live TrueForge Turn ID:** `01m7wn57g6cm1ch8qzsykb0w3d`
- **Terminal Turn Status:** `COMPLETED`
- **Selection Captured:** `src/flask/helpers.py` lines 28–33 (`0-based` UTF-16 offsets `703..1002`, `eol="\r\n"`, original SHA-256 `49848f1857424cdf16e411d1da93b9e36dcbbaf6b1e324166a67634be7c4fcc7`)
- **TrueForge Tool & Human Approval Flow:** `list_tools` -> `get_tool_info` -> `propose_edit` (**human approval required & granted**) -> `run_workspace_command` (overlay verification; disallowed `pip` / `--version` flags safely blocked by `CommandPolicy`).
- **Proposal Mode & Invariants:** `editMode: "range"`, `prefixPreserved: true`, `suffixPreserved: true`, 1 localized hunk, disk untouched prior to apply.
- **Actual Model-Generated Unified Diff (compared to prior Attempt 1 `-581` lines and Attempt 2 `-635` lines):**

```diff
--- a/src/flask/helpers.py
+++ b/src/flask/helpers.py
@@ -28,9 +28,12 @@
 def get_debug_flag() -> bool:
     """Get whether debug mode should be enabled for the app, indicated by the
     :envvar:`FLASK_DEBUG` environment variable. The default is ``False``.
+
+    Values that are considered false are ``0``, ``false``, ``no``,
+    ``off``, and ``n`` (case-insensitive).
     """
     val = os.environ.get("FLASK_DEBUG")
-    return bool(val and val.lower() not in {"0", "false", "no"})
+    return bool(val and val.lower() not in {"0", "false", "no", "off", "n"})
 
 
 def get_load_dotenv(default: bool = True) -> bool:
```

- **Git Diff Stat After Accepting & Applying Hunk:** `src/flask/helpers.py | 5 ++++-` (`1 file changed, 4 insertions(+), 1 deletion(-)`)
- **Runtime Verification (`%TEMP%\patchpilot-flask-benchmark\.venv\Scripts\python.exe`):**
  - `FLASK_DEBUG=off` -> `False`
  - `FLASK_DEBUG=OFF` -> `False`
  - `FLASK_DEBUG=n` -> `False`
  - `FLASK_DEBUG=N` -> `False`
  - `FLASK_DEBUG=1` -> `True`
  - Unset `FLASK_DEBUG` -> `False`
- **Benchmark Cleanliness & Undo:** `UndoManager.undoLastApply()` restored `src/flask/helpers.py` verbatim to SHA-256 `49848f1857424cdf16e411d1da93b9e36dcbbaf6b1e324166a67634be7c4fcc7`; `git status --short` was empty both before and after the run.

---

## 6. Remaining Limitations

- **Unsaved Editor Buffers During Inline Edit:** Because `ProposalStore` anchors range edits to the on-disk file SHA-256 read by the out-of-process MCP server, `PatchPilotController.runInlineEdit()` prompts the user to save dirty buffers (`Save & Continue`) before launching an inline edit rather than reading unsaved editor buffers directly.
- **Upstream Model Latency Variance:** With `preload: false`, TrueForge performs deferred tool discovery (`list_tools` -> `get_tool_info` -> `call_tool`), requiring multiple sequential LLM round-trips; slower preview model endpoints (e.g., `gemini-3.1-flash-lite` under heavy upstream load) can occasionally encounter upstream `Headers Timeout Error` on later round-trips, whereas faster configured models (e.g., `gemini-flash-lite-latest`) complete cleanly.
- **Overlay Python Environment Discovery:** When the model invokes `run_workspace_command` with bare `python -m pytest`, Windows resolves the first `python` on `PATH` rather than automatically activating a workspace-local `.venv\Scripts\python.exe` inside the disposable overlay. (Tracked as a future usability improvement; out of scope for this inline-edit preservation fix.)
