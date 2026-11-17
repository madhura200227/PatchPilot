# PatchPilot — System Architecture Specification

**Product:** PatchPilot  
**Status:** Proposed Architecture & Technical Design (Milestone 0 Foundation)  
**Agent Harness:** TrueForge (`@truefoundry/trueforge-sdk`)  
**Documentation Authority:** Subordinate to [docs/PRD.md](file:///e:/MADHURA/PROJECTS%20madhura/PatchPilot/docs/PRD.md)

---

## 1. Architectural Philosophy & Principles

PatchPilot is architected around five fundamental engineering principles:

1. **Isolation by Default:** AI code generation must not mutate the developer's active working tree without explicit human authorization. Proposed operations take place in dedicated, isolated Git worktrees.
2. **TrueForge Sole Loop Authority:** All model-driven reasoning, planning, tool selection, and agent execution cycles are strictly governed by **TrueForge**. PatchPilot provides the editor client, tool implementations, and verification evidence, but never implements an independent model-driven loop.
3. **Semantic Granularity:** Code changes are treated as discrete, reviewable hunks mapped to language symbols, rather than opaque, whole-file rewrites.
4. **Empirical Verification:** Proposed code modifications are validated against project test suites and linters executed inside the isolated sandbox before final review.
5. **Auditable Provenance:** Every completed patch is accompanied by a structured manifest (the **Patch Passport**) that links user prompt, agent plan, affected files, review decisions, and test logs.

---

## 2. Five-Layer Architecture Overview

PatchPilot is organized into five distinct operational layers with explicit boundaries:

```mermaid
flowchart TD
    subgraph L1["Layer 1: VS Code Extension Host (Client & UI)"]
        ChatWebview["Sidebar Chat Provider<br/>(Prompt & Progress UI)"]
        HunkWebview["Hunk Intelligence Panel<br/>(Granular Diff Staging)"]
        PassportWebview["Patch Passport Viewer<br/>(Evidence & Audit Ledger)"]
        DiffEditor["Native Diff Integration<br/>(Editor Tabs & Markers)"]
    end

    subgraph L2["Layer 2: TrueForge SDK Client (Bridge & Session Lifecycle)"]
        SDKClient["TrueForgeClient<br/>(@truefoundry/trueforge-sdk)"]
        FSM["Session State Machine<br/>(IDLE, PLANNING, EXECUTING, REVIEW, RECOVERY)"]
        CancelManager["Cancellation Manager<br/>(AbortController & Process Signal Dispatcher)"]
    end

    subgraph L3["Layer 3: TrueForge Agent Runtime (Sole Agent Loop)"]
        TFHarness["TrueForge Runtime Engine<br/>(Autonomous Agent Loop)"]
        TokenOptimizer["Context Compaction & Token Optimizer"]
        ToolGateway["Tool / MCP Gateway<br/>(Proposed Bridge — OD-05)"]
    end

    subgraph L4["Layer 4: Repository & Execution Tools (Harness Tools)"]
        RepoBrain["RepoBrain Engine<br/>(ripgrep Lexical P0 + Tree-sitter AST P1)"]
        WorktreeMgr["Git Worktree Manager<br/>(Isolated Sandbox)"]
        VerifyRunner["Verification Harness<br/>(pytest, flake8, mypy)"]
        HunkEngine["Hunk Decomposition Engine<br/>(Patch Splitter & Merger)"]
    end

    subgraph L5["Layer 5: Patch Passport & Persistence (Audit & Recovery)"]
        SQLiteStore["SQLite State Store<br/>(.patchpilot/session.db)"]
        PassportEngine["Patch Passport Generator"]
        RecoveryEngine["Idempotent Recovery Controller"]
    end

    ChatWebview --> SDKClient
    HunkWebview --> HunkEngine
    PassportWebview --> PassportEngine

    SDKClient --> FSM
    FSM --> TFHarness
    CancelManager -.->|Abort Signal| TFHarness
    CancelManager -.->|SIGINT / SIGTERM| VerifyRunner

    TFHarness --> ToolGateway
    ToolGateway --> RepoBrain
    ToolGateway --> WorktreeMgr
    ToolGateway --> VerifyRunner
    ToolGateway --> HunkEngine

    FSM --> SQLiteStore
    VerifyRunner --> PassportEngine
    HunkEngine --> PassportEngine
    SQLiteStore --> RecoveryEngine
```

---

## 3. Layer Specifications & Component Contracts

### 3.1 Layer 1: VS Code Extension Host
- **Role:** User interaction, command registration, and IDE integration.
- **Components:**
  - `ChatViewProvider`: Custom webview in the primary sidebar for prompt entry, progress streaming, and high-level interaction.
  - `HunkReviewPanel`: Webview panel rendering semantic diff hunks with per-hunk actions: `[Accept]`, `[Reject]`, `[Re-prompt]`.
  - `PassportViewer`: Visual inspector for the generated Patch Passport receipt.
  - `CommandController`: Registers VS Code commands (e.g., `patchpilot.startSession`, `patchpilot.cancel`, `patchpilot.openPassport`).
- **Boundary:** Never communicates directly with LLM providers; all actions route through Layer 2.

### 3.2 Layer 2: TrueForge SDK Client
- **Role:** Manages the client-side session lifecycle, handles real-time event streaming, and coordinates cancellation.
- **Components:**
  - `TrueForgeClient`: Interfaces with `@truefoundry/trueforge-sdk`. Connects to the local or remote TrueForge daemon.
  - `SessionStateMachine`: Maintains strict state invariants:
    `IDLE -> PLANNING -> EXECUTING_TOOLS -> VERIFYING -> HUMAN_REVIEW -> APPLIED / CANCELLED`.
  - `CancellationManager`: Tracks active asynchronous operations and propagates cooperative cancellation tokens (`AbortSignal`) to TrueForge and `SIGINT`/`SIGTERM` to running child processes.

### 3.3 Layer 3: TrueForge Agent Runtime
- **Role:** **The sole model-driven execution loop.** 
- **Architectural Mandate:** PatchPilot strictly delegates all autonomous decision-making, planning, and tool invocation to TrueForge. PatchPilot does not contain a fallback or parallel model loop.
- **Capabilities Leveraged:**
  - TrueForge's context compaction algorithms to handle large repositories (`pallets/flask`).
  - TrueForge's tool execution framework and streaming protocol.
  - Model and provider neutrality (OpenAI, Anthropic, Google Gemini, Ollama, self-hosted LLMs).
- **Transport Decision (OD-05):** The exact transport between TrueForge and the workspace (MCP server bridge vs synchronized container mount) is subject to an architectural spike in Milestone 0.

### 3.4 Layer 4: Repository & Execution Tools
- **Role:** Local execution capabilities exposed to TrueForge as structured tools.
- **Components:**
  1. **RepoBrain:**
     - **Lexical Indexer (P0):** `ripgrep` (`rg`) integration for fast regex, keyword, and identifier searches.
     - **AST Parser (P1):** Tree-sitter bindings for language-specific syntax analysis (classes, functions, decorators, imports).
     - **Context Relevance Ranker:** Ranks candidate snippets and files by proximity to query terms. *Note: Full semantic call-graph analysis is an aspirational P1 goal; PatchPilot does not claim a complete semantic dependency graph prior to implementation.*
  2. **Git Worktree Manager:**
     - Provisions an isolated worktree at `.patchpilot/worktrees/wt-<session_id>`.
     - Validates all file read/write paths to prevent directory traversal outside the worktree sandbox.
     - Generates unified diffs against the base branch (`git diff HEAD`).
     - Prunes worktrees upon session completion or cancellation.
  3. **Verification Harness:**
     - Dispatches automated test commands (e.g., `pytest tests/`) inside the worktree environment.
     - Parses stdout, stderr, and exit codes into structured diagnostic payloads.
     - Runs linting tools (`flake8`, `mypy`) to catch static defects before review.
  4. **Hunk Decomposition Engine:**
     - Parses standard unified diffs (`git diff`) into individual semantic hunks.
     - Manages selective patch staging via custom `git apply --cached` patch reconstruction.

### 3.5 Layer 5: Patch Passport & Persistence Layer
- **Role:** Audit logging, state persistence, crash recovery, and verification attestation.
- **Components:**
  - `DatabaseManager`: Embedded SQLite database (`.patchpilot/session.db`) managing extension-side tables.
  - `PatchPassportGenerator`: Generates the structured JSON manifest attesting to the completed change.
  - `RecoveryController`: On extension startup, inspects SQLite for interrupted sessions and initiates safe recovery or cleanup.

---

## 4. Data Persistence & SQLite Schema

To support idempotent recovery and hunk review without duplicating TrueForge's session database, PatchPilot defines the following extension-side schema (aligned with PRD Section 13.2):

```mermaid
erDiagram
    workspace_sessions ||--o{ tasks : contains
    tasks ||--o{ patch_revisions : produces
    tasks ||--o{ recovery_checkpoints : records
    tasks ||--o{ task_events : logs
    patch_revisions ||--o{ review_hunks : contains
    patch_revisions ||--o{ verification_runs : verifies

    workspace_sessions {
        string id PK
        string workspace_uri
        string repository_root
        string original_branch
        string base_commit
        string worktree_path
        string trueforge_session_id
        string status
        int created_at
        int updated_at
    }

    tasks {
        string id PK
        string workspace_session_id FK
        string user_request
        string plan_json
        int plan_revision
        string status
        int created_at
        int updated_at
    }

    patch_revisions {
        string id PK
        string task_id FK
        int revision_number
        string base_commit
        string patch_hash
        string patch_path
        string status
        int created_at
    }

    review_hunks {
        string id PK
        string patch_revision_id FK
        string file_path
        string hunk_hash
        int old_start
        int old_count
        int new_start
        int new_count
        string review_status
        string explanation
        int updated_at
    }

    verification_runs {
        string id PK
        string patch_revision_id FK
        string command
        string working_directory
        int exit_code
        string status
        string stdout_path
        string stderr_path
        int duration_ms
        int started_at
        int finished_at
    }

    recovery_checkpoints {
        string id PK
        string task_id FK
        int checkpoint_number
        string trueforge_turn_id
        string last_event_reference
        string workspace_fingerprint
        string completed_operations_json
        string state_json
        int created_at
    }

    task_events {
        string id PK
        string task_id FK
        string event_type
        string event_payload_json
        int created_at
    }
```

---

## 5. Security & Isolation Architecture

1. **Path Traversal Containment:** Every file modification tool call is checked against the worktree root using canonical path resolution (`fs.realpathSync`). Any path resolving outside `.patchpilot/worktrees/wt-<id>` is rejected.
2. **Secret Masking & Sanitization:** RepoBrain automatically ignores `.env`, `*.key`, `id_rsa`, `.git/credentials`, and sensitive config files.
3. **Execution Sandboxing:** Subprocess commands are strictly parameterized. Test runner commands are whitelisted to `pytest`, `python -m unittest`, `flake8`, and `mypy`.
4. **Worktree Cleanup & Garbage Collection:** Worktree removal uses `git worktree remove --force` followed by deletion of the temporary session branch. On startup, PatchPilot sweeps `.patchpilot/worktrees/` to clean up any orphaned directories left by hard process crashes.
