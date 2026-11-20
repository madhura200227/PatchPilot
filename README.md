# PatchPilot

> **Code changes you can inspect, verify, and trust — powered strictly by TrueForge.**

[![Competition: TrueFoundry Forge-a-thon](https://img.shields.io/badge/Competition-TrueFoundry%20Forge--a--thon-blue.svg)](https://techfest.org)
[![Host: Techfest, IIT Bombay](https://img.shields.io/badge/Host-Techfest%2C%20IIT%20Bombay-orange.svg)](https://techfest.org)
[![Agent Harness: TrueForge](https://img.shields.io/badge/Agent%20Harness-TrueForge-5b46e8.svg)](https://trueforge.dev)
[![Target Benchmark: pallets/flask 3.1.3](https://img.shields.io/badge/Benchmark-pallets%2Fflask%203.1.3-lightgrey.svg)](https://github.com/pallets/flask)
[![Status: MVP Implemented](https://img.shields.io/badge/Status-VS%20Code%20MVP%20Implemented-brightgreen.svg)](#project-status)

**PatchPilot** is a VS Code-native AI coding agent built for the **TrueFoundry Forge-a-thon (Techfest, IIT Bombay)**. TrueForge owns the entire model-driven agent loop, reasoning, tool selection, context compaction, and approval gating, while PatchPilot delivers an editor-native VS Code workflow with:

- **Agent Mode & Inline Edit (`Ctrl+Shift+I` / `Cmd+Shift+I`):** Multi-file autonomous coding and selection-scoped inline edits powered strictly by TrueForge.
- **Deterministic Context Assembly (`@file`, `@symbol`, BM25):** Explicit mention resolution with unknown-reference reporting, VS Code workspace symbol lookup with lexical fallback, deterministic BM25 ranking, and a visible estimated token budget (`16,000` default).
- **Authenticated Loopback MCP Workspace Server (`dist/mcpServer.js`):** Out-of-process Streamable HTTP MCP server exposing 8 annotated workspace tools with per-process Bearer auth, strict path/dotfile/symlink confinement, and allowlisted command execution.
- **Proposal-Only Editing & Hunk-by-Hunk Review:** The model never writes directly to your workspace. `propose_edit` stages diffs in isolated temporary storage; you accept or reject individual hunks before applying via `vscode.WorkspaceEdit`.
- **Disposable Execution Overlay:** Verification commands (`pytest`, `flask`, `node --test`, etc.) execute inside a temporary workspace copy containing active proposals — leaving your host working tree untouched until review.
- **Safe Undo, Streaming, Approvals & Cancellation:** Post-apply hash-verified `patchpilot.undoLastApply`, live SSE streaming, native TrueForge `tool.approval_required` approve/deny cards, and server-first cancellation with child-process termination and pending-proposal cleanup.

---

## Architecture Overview

```text
VS Code (dist/extension.js)
  ├── Agent Sidebar Webview (streaming, tool timeline, approvals, context plan)
  ├── Inline Edit (Ctrl+Shift+I / Cmd+Shift+I + selection expansion guard)
  ├── Hunk Review Panel + Native vscode.diff + WorkspaceEdit Apply & Undo
  ├── Deterministic Context Assembly (@file, @symbol, BM25, 16k est. budget)
  ├── TrueForge SDK Client (@truefoundry/trueforge-sdk@0.185.0)
  │     └──► TrueForge Local Server (http://127.0.0.1:8790)
  │            └──► TrueForge Agent Loop (Configured Model + preload:false + compaction)
  │                   └──► Streamable HTTP MCP + Bearer Auth
  └── WorkspaceProcessManager (IPC token handoff)
        └──► Out-of-Process MCP Server (dist/mcpServer.js, 127.0.0.1:<port>)
               ├── Read / Search / Symbol / Context Plan (read-only)
               ├── propose_edit (isolated ProposalStore, never writes workspace)
               └── run_workspace_command (allowlisted, disposable overlay)
```

For full flow diagrams and security boundary documentation, see [docs/MVP_ARCHITECTURE.md](docs/MVP_ARCHITECTURE.md).

---

## Prerequisites

- **Node.js:** `v22.14.0` or newer (required by `@truefoundry/trueforge`; verified on `v24.19.0`)
- **npm:** `v10.x` or newer
- **Visual Studio Code:** `v1.101.0` or newer (Electron Node 22+ extension host; verified on `1.146.0`)
- **Git:** `v2.30.0` or newer
- **Python 3.10+ & `pytest`:** For verifying the official `pallets/flask` 3.1.3 benchmark tasks

---

## Quick Start (Clean Clone)

### 1. Install Dependencies & Compile Extension + MCP Server
```powershell
git clone https://github.com/madhura200227/PatchPilot.git
cd PatchPilot
npm install
npm run compile
```

This builds both self-contained bundles:
- `dist/extension.js` (VS Code Extension Host)
- `dist/mcpServer.js` (Out-of-process loopback Workspace MCP server)

### 2. Start Local TrueForge Server
PatchPilot keeps TrueForge's SSRF guard enabled and uses only the narrow loopback allowlist for local development:

```powershell
# PowerShell (Windows)
$env:HOST = "127.0.0.1"
$env:OUTBOUND_URL_ALLOWED_HOSTS = '["127.0.0.1","localhost"]'
npx --yes @truefoundry/trueforge@0.185.1 --port 8790
```

```bash
# macOS / Linux
HOST=127.0.0.1 OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' npx --yes @truefoundry/trueforge@0.185.1 --port 8790
```

### 3. Configure a Model in TrueForge
1. Open `http://127.0.0.1:8790` in your browser.
2. Go to **Settings -> Model Providers** and add your LLM provider and model.
3. PatchPilot reads configured models from TrueForge (`client.models.list()`) and never asks for or stores upstream provider keys.

### 4. Launch PatchPilot in VS Code Extension Development Host
```powershell
code --extensionDevelopmentPath=. <path-to-target-workspace>
```
Or open `PatchPilot` in VS Code and press **`F5`**.

### 5. Configure the PatchPilot Agent & MCP Connector
1. Open the **PatchPilot** sidebar in the Activity Bar (or run **`PatchPilot: Open Agent Panel`**).
2. Click **Configure** (or run **`PatchPilot: Configure TrueForge`**):
   - Confirms the TrueForge server URL (default `http://127.0.0.1:8790`).
   - Lets you pick any model configured in TrueForge.
   - Starts the loopback MCP workspace server (`dist/mcpServer.js`), registers the `patchpilot-workspace` connector via TrueForge's API, verifies discovery of all 8 tools, and creates/updates the `patchpilot` agent based on [agents/patchpilot.agent.json](agents/patchpilot.agent.json).

---

## Using PatchPilot

### Inline Edit (`Ctrl+Shift+I` / `Cmd+Shift+I`)
1. Open a file in a trusted workspace and select the code region to edit.
2. Press **`Ctrl+Shift+I`** (macOS: **`Cmd+Shift+I`**) or run **`PatchPilot: Inline Edit Selection`**.
3. Describe the change in plain language.
4. Approve `propose_edit` in the PatchPilot sidebar when TrueForge pauses for approval.
5. Inspect the diff in **PatchPilot Change Review** (any edits outside your selected range are explicitly flagged), accept the desired hunk(s), and click **Apply Accepted Changes**.

### Agent Mode (Multi-File Coding)
1. Open the **PatchPilot** sidebar (`PatchPilot: Open Agent Panel`).
2. Enter your task. You may optionally cite `@file:path/to/file` or `@symbol:symbolName`, or omit filenames entirely to let TrueForge discover relevant files via MCP search tools.
3. Watch live streaming output, the **Context Assembly Plan**, and the **Tool Activity Timeline**.
4. Approve or deny sensitive tool calls (`propose_edit`, `run_workspace_command`) directly in the Agent panel.
5. Click **Open Diff Review** to accept or reject individual hunks across all modified/created files, then click **Apply Accepted Changes**.

### Safe Undo
- Run **`PatchPilot: Undo Last Apply`** (or click **Undo Last Apply** in the Agent or Review panel).
- PatchPilot verifies every file's current SHA-256 against the post-apply hash before restoring original content or removing PatchPilot-created new files — never overwriting edits you made afterward.

### Cancellation
- Click **Cancel** in the Agent panel or run **`PatchPilot: Cancel Active Run`**.
- PatchPilot calls TrueForge's server cancellation API, terminates any running overlay test subprocess, discards unaccepted pending proposals from the cancelled run, and closes the stream cleanly.

---

## TrueForge Context Engineering Configuration

[agents/patchpilot.agent.json](agents/patchpilot.agent.json) configures TrueForge's built-in context-engineering controls using the verified `@truefoundry/trueforge-sdk@0.185.0` schema:
- **Deferred MCP Tool Loading (`"preload": false`):** Avoids injecting all MCP tool schemas upfront on every turn; TrueForge discovers tool definitions on demand.
- **Context Compaction (`"config.context_management.compaction.enabled": true`):** Summarizes older conversation/tool history automatically as context grows.
- **Large Tool-Response Offloading (`"config.context_management.large_tool_response.enabled": true`):** Prevents oversized tool outputs from exhausting model context windows.
- **Explicit Literal Approvals (`"require_approval_for_tools": ["propose_edit", "run_workspace_command"]`):** Enforces human-in-the-loop approval by literal tool name rather than relying only on generic annotations.

---

## Running Tests & Packaging

```powershell
# TypeScript type-check & production bundles (dist/extension.js + dist/mcpServer.js)
npm run lint
npm run compile

# Unit tests (security, context assembly, patch/hunk/undo/overlay, MCP server, TrueForge client)
npm run test:unit

# Real VS Code Extension Development Host E2E tests (@vscode/test-electron)
npm run test:vscode

# Live TrueForge integration tests (requires TrueForge server running on 127.0.0.1:8790)
npm run test:integration

# Package VSIX archive (patchpilot-0.2.0.vsix)
npm run package
```

---

## Official Forge-a-thon Tasks (A, B, and C)

See the exact reproducible step-by-step walkthrough in [docs/DEMO_RUNBOOK.md](docs/DEMO_RUNBOOK.md) and requirement mapping in [docs/COMPETITION_REQUIREMENTS_TRACEABILITY.md](docs/COMPETITION_REQUIREMENTS_TRACEABILITY.md).

---

## Project Status & Known Limitations

| Area | Status | Notes |
|---|---|---|
| VS Code Extension UI, Commands, Keybinding & VSIX | **Implemented & Verified** | Verified in real VS Code Extension Development Host (`1.146.0`) and packaged to `patchpilot-0.2.0.vsix` |
| Out-of-Process MCP Server (8 Annotated Tools) & Hardened Security | **Implemented & Verified** | Verified against live TrueForge v0.185.1 connector registration & 8-tool discovery |
| Deterministic Context Assembly (`@file`, `@symbol`, BM25, 16k est. budget) | **Implemented & Verified** | Verified on unit fixtures and real `pallets/flask` 3.1.3 |
| Hunk-by-Hunk Review, Selective Apply, Stale Detection & Safe Undo | **Implemented & Verified** | Verified via real `vscode.WorkspaceEdit` in Extension Development Host |
| Task C Failure Resilience (Unreachable Server & Invalid Key) | **Verified (PASS)** | Confirmed zero retries on 401 and zero workspace mutations |
| Live Model-Backed Execution (Tasks A & B end-to-end LLM turns) | **Blocked on External Provider Key** | Requires a valid LLM provider API key configured inside TrueForge Settings -> Model Providers |

### Known Limitations
- **Upstream LLM Provider Key:** Real autonomous model-backed completion of Tasks A and B requires configuring a valid provider key in local TrueForge (`http://127.0.0.1:8790` Settings -> Model Providers).
- **Localhost SSRF Allowlist:** Local TrueForge blocks loopback MCP URLs by default; local development requires starting TrueForge with `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'`.
- **Windows TOCTOU Caveat:** Node on Windows lacks POSIX `O_NOFOLLOW` open flags; PatchPilot performs canonical pre-open and post-open `realpath` checks plus Workspace Trust gating, but a narrow OS-level TOCTOU race remains theoretically possible under adversarial local filesystem tampering.
- **File Deletion/Rename Proposals:** Out of MVP scope; `propose_edit` supports modifying existing files and creating new files only.
- **Historical Documentation:** Prompt 005 spike artifacts are preserved under `spikes/mcp-workspace/` for traceability while production code lives under `src/`.
