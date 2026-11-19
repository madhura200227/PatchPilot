# PatchPilot — Competition Requirements Traceability Matrix

This document maps every TrueFoundry Forge-a-thon eligibility gate and mandatory capability to its actual implementation modules, automated tests, and verified evidence in the `feature/forgeathon-mvp` branch.

---

## 1. Eligibility Gate Traceability

| Eligibility Mandate | Implementing Modules | Verification Evidence | Status |
|---|---|---|---|
| **TrueForge Sole Agent Loop** | [src/trueforge/clientFactory.ts](file:///d:/Projects/PatchPilot/src/trueforge/clientFactory.ts), [src/trueforge/sessionManager.ts](file:///d:/Projects/PatchPilot/src/trueforge/sessionManager.ts), [src/trueforge/turnStream.ts](file:///d:/Projects/PatchPilot/src/trueforge/turnStream.ts), [src/controller/PatchPilotController.ts](file:///d:/Projects/PatchPilot/src/controller/PatchPilotController.ts) | Zero direct OpenAI/Anthropic/Gemini SDK imports or direct provider HTTP calls in `src/`; all turns flow exclusively through `@truefoundry/trueforge-sdk@0.185.0` | **VERIFIED** |
| **Model Independence (Configured in TrueForge)** | [src/trueforge/agentManager.ts](file:///d:/Projects/PatchPilot/src/trueforge/agentManager.ts), [src/trueforge/connectionManager.ts](file:///d:/Projects/PatchPilot/src/trueforge/connectionManager.ts), [agents/patchpilot.agent.json](file:///d:/Projects/PatchPilot/agents/patchpilot.agent.json) | Model catalogue fetched via `client.models.list()`; zero hardcoded provider credentials; `MODEL_NOT_CONFIGURED` verified live against TrueForge v0.185.1 | **VERIFIED** |
| **TrueForge Context Engineering** | [agents/patchpilot.agent.json](file:///d:/Projects/PatchPilot/agents/patchpilot.agent.json), [src/trueforge/agentManager.ts](file:///d:/Projects/PatchPilot/src/trueforge/agentManager.ts) | `preload: false`, `contextManagement.compaction.enabled: true`, `contextManagement.largeToolResponse.enabled: true`, and literal `requireApprovalForTools: ["propose_edit", "run_workspace_command"]` persisted & verified round-trip via `client.agents.get()` on live TrueForge v0.185.1 | **VERIFIED** |
| **Editor Capabilities via MCP** | [src/workspace/mcpServerCore.ts](file:///d:/Projects/PatchPilot/src/workspace/mcpServerCore.ts), [src/workspace/mcpServerEntry.ts](file:///d:/Projects/PatchPilot/src/workspace/mcpServerEntry.ts), [src/workspace/WorkspaceProcessManager.ts](file:///d:/Projects/PatchPilot/src/workspace/WorkspaceProcessManager.ts), [src/workspace/WorkspaceMcpAdapter.ts](file:///d:/Projects/PatchPilot/src/workspace/WorkspaceMcpAdapter.ts) | All 8 annotated MCP tools discovered over authenticated loopback Streamable HTTP by live TrueForge v0.185.1 (`mcpTrueForgeIntegration.test.ts`) and in real VS Code Electron Extension Host (`extension.e2e.test.ts`) | **VERIFIED** |

---

## 2. Five Mandatory Capabilities Traceability

### Capability 1: Editor-Native VS Code Extension & Inline Edit (Task A)

| Aspect | Implementation | Test Coverage | Status |
|---|---|---|---|
| Activity Bar, Sidebar Agent View & Keybinding (`Ctrl+Shift+I` / `Cmd+Shift+I`) | [package.json](file:///d:/Projects/PatchPilot/package.json), [src/extension.ts](file:///d:/Projects/PatchPilot/src/extension.ts), [src/ui/AgentViewProvider.ts](file:///d:/Projects/PatchPilot/src/ui/AgentViewProvider.ts), [src/commands/mvpCommands.ts](file:///d:/Projects/PatchPilot/src/commands/mvpCommands.ts) | `extensionHost.test.ts`, real VS Code Extension Development Host `extension.e2e.test.ts` (tests 1–5) | **PASS (Host Verified)** |
| Inline selection capture, surrounding context, stale version check & expansion detection | [src/controller/PatchPilotController.ts](file:///d:/Projects/PatchPilot/src/controller/PatchPilotController.ts), [src/workspace/patchEngine.ts](file:///d:/Projects/PatchPilot/src/workspace/patchEngine.ts) | `workspaceAndHunks.test.ts` (`detectSelectionExpansion`), `extension.e2e.test.ts` (test 5) | **PASS (Infrastructure)** / **BLOCKED (Live LLM Key for Task A completion)** |

### Capability 2: Autonomous Multi-File Agent Mode (Task B)

| Aspect | Implementation | Test Coverage | Status |
|---|---|---|---|
| Agent Panel prompt dispatch, tool timeline, multi-file proposals without naming files | [src/controller/PatchPilotController.ts](file:///d:/Projects/PatchPilot/src/controller/PatchPilotController.ts), [src/ui/AgentViewProvider.ts](file:///d:/Projects/PatchPilot/src/ui/AgentViewProvider.ts), [src/workspace/proposalStore.ts](file:///d:/Projects/PatchPilot/src/workspace/proposalStore.ts) | `workspaceAndHunks.test.ts` (multi-file proposals + apply + undo), `mcpServer.test.ts`, real Flask 3.1.3 discovery test (`src/flask/cli.py`, `src/flask/config.py`, `docs/cli.rst`, `docs/config.rst` ranked automatically) | **PASS (Infrastructure)** / **BLOCKED (Live LLM Key for Task B completion)** |
| Disposable overlay test execution (`run_workspace_command`) | [src/workspace/executionOverlay.ts](file:///d:/Projects/PatchPilot/src/workspace/executionOverlay.ts), [src/security/commandPolicy.ts](file:///d:/Projects/PatchPilot/src/security/commandPolicy.ts) | `workspaceAndHunks.test.ts`, `mcpServer.test.ts`, Flask 3.1.3 overlay invocation (`git status` remained `CLEAN`) | **PASS** |

### Capability 3: Deterministic Context Assembly & Budget

| Aspect | Implementation | Test Coverage | Status |
|---|---|---|---|
| `@file` and `@symbol` parsing + unknown reference reporting | [src/context/mentionParser.ts](file:///d:/Projects/PatchPilot/src/context/mentionParser.ts), [src/context/contextAssembler.ts](file:///d:/Projects/PatchPilot/src/context/contextAssembler.ts) | `contextAssembly.test.ts` | **PASS** |
| VS Code Workspace Symbol Provider + deterministic lexical fallback | [src/context/symbolResolver.ts](file:///d:/Projects/PatchPilot/src/context/symbolResolver.ts), [src/workspace/vscodeMutations.ts](file:///d:/Projects/PatchPilot/src/workspace/vscodeMutations.ts) | `contextAssembly.test.ts`, Flask 3.1.3 `get_debug_flag` lookup (`src/flask/helpers.py:28-33`) | **PASS** |
| BM25 automatic retrieval + 16,000 estimated token budget + visible Context Plan (`get_context_plan`) | [src/context/relevanceRanker.ts](file:///d:/Projects/PatchPilot/src/context/relevanceRanker.ts), [src/context/tokenBudget.ts](file:///d:/Projects/PatchPilot/src/context/tokenBudget.ts), [src/workspace/mcpServerCore.ts](file:///d:/Projects/PatchPilot/src/workspace/mcpServerCore.ts) | `contextAssembly.test.ts`, `mcpServer.test.ts`, Flask 3.1.3 Task B plan (`2827 / 16000` est. tokens) | **PASS** |

### Capability 4: Safe Proposal-Only Editing, Hunk Review, Apply & Undo

| Aspect | Implementation | Test Coverage | Status |
|---|---|---|---|
| Proposal-only `propose_edit` (zero disk writes during agent turns) | [src/workspace/proposalStore.ts](file:///d:/Projects/PatchPilot/src/workspace/proposalStore.ts), [src/workspace/mcpServerCore.ts](file:///d:/Projects/PatchPilot/src/workspace/mcpServerCore.ts) | `workspaceAndHunks.test.ts`, `mcpServer.test.ts`, `extension.e2e.test.ts` | **PASS** |
| Hunk-by-hunk Review UI + Native `vscode.diff` + Selective Accept/Reject + Stale Conflict Guard | [src/workspace/patchEngine.ts](file:///d:/Projects/PatchPilot/src/workspace/patchEngine.ts), [src/workspace/hunkReview.ts](file:///d:/Projects/PatchPilot/src/workspace/hunkReview.ts), [src/ui/ReviewPanelProvider.ts](file:///d:/Projects/PatchPilot/src/ui/ReviewPanelProvider.ts), [src/ui/ProposalDiffContentProvider.ts](file:///d:/Projects/PatchPilot/src/ui/ProposalDiffContentProvider.ts) | `workspaceAndHunks.test.ts`, real VS Code `extension.e2e.test.ts` (test 4: accepted hunk 1, rejected hunk 2, applied via `WorkspaceEdit`) | **PASS (Host Verified)** |
| Hash-verified Undo (`patchpilot.undoLastApply`) | [src/workspace/undoManager.ts](file:///d:/Projects/PatchPilot/src/workspace/undoManager.ts), [src/workspace/vscodeMutations.ts](file:///d:/Projects/PatchPilot/src/workspace/vscodeMutations.ts) | `workspaceAndHunks.test.ts` (undo + post-apply conflict block + created file deletion), real VS Code `extension.e2e.test.ts` (test 4) | **PASS (Host Verified)** |

### Capability 5: Streaming, Human Approvals, Safe Cancellation & Failure Resilience (Task C)

| Aspect | Implementation | Test Coverage | Status |
|---|---|---|---|
| Real SSE streaming & delta deduplication | [src/trueforge/turnStream.ts](file:///d:/Projects/PatchPilot/src/trueforge/turnStream.ts), [src/trueforge/eventTypes.ts](file:///d:/Projects/PatchPilot/src/trueforge/eventTypes.ts) | `turnStream.test.ts`, `eventTypes.test.ts`, `trueforgeMvp.test.ts` | **PASS** |
| Real TrueForge `tool.approval_required` -> `user.tool_approval` -> `subscribeToTurn` resume | [src/trueforge/approvalManager.ts](file:///d:/Projects/PatchPilot/src/trueforge/approvalManager.ts), [src/trueforge/turnStream.ts](file:///d:/Projects/PatchPilot/src/trueforge/turnStream.ts) | `trueforgeMvp.test.ts` | **PASS (Unit Verified; Live LLM Approval BLOCKED on provider key)** |
| Server-first Cancellation + Local Subprocess Kill + Proposal Discard | [src/trueforge/cancellationManager.ts](file:///d:/Projects/PatchPilot/src/trueforge/cancellationManager.ts), [src/workspace/mcpServerCore.ts](file:///d:/Projects/PatchPilot/src/workspace/mcpServerCore.ts) | `cancellationManager.test.ts`, `trueforgeMvp.test.ts`, `security.test.ts`, `mcpTrueForgeIntegration.test.ts` | **PASS** |
| Task C Resilience (unreachable server & invalid key -> clean error, no retry on 401, zero disk mutation) | [src/trueforge/connectionManager.ts](file:///d:/Projects/PatchPilot/src/trueforge/connectionManager.ts), [src/trueforge/turnStream.ts](file:///d:/Projects/PatchPilot/src/trueforge/turnStream.ts), [src/controller/PatchPilotController.ts](file:///d:/Projects/PatchPilot/src/controller/PatchPilotController.ts) | `trueforgeMvp.test.ts`, real VS Code `extension.e2e.test.ts` (test 5), live TrueForge v0.185.1 `mcpTrueForgeIntegration.test.ts` (tests 1 & 3) | **PASS** |
