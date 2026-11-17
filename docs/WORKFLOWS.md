# PatchPilot — Workflow & Lifecycle Architecture

## 1. End-to-End Execution Lifecycle

The lifecycle of a PatchPilot session moves through explicit stages to guarantee safety, verification, and developer control.

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> RepositoryAnalysis: User Enters Task Prompt
    RepositoryAnalysis --> ContextRetrieval: RepoBrain AST & ripgrep Scan
    ContextRetrieval --> TaskPlanning: Ranked Code Slices to TrueForge
    TaskPlanning --> WorktreeCreation: Structured Plan Generated
    WorktreeCreation --> AutonomousExecution: Isolated Worktree Ready (.patchpilot/worktrees/wt-id)
    
    state AutonomousExecution {
        [*] --> ToolCall
        ToolCall --> FileEdit: Apply Changes in Worktree
        FileEdit --> NextStep: Continue TrueForge Loop
        NextStep --> ToolCall: Additional Tools Needed
        NextStep --> [*]: Edits Complete
    }

    AutonomousExecution --> Verification: Trigger Test Runner (pytest)
    
    state Verification {
        [*] --> RunTests
        RunTests --> Evaluate: Test Exit Code & Diagnostics
        Evaluate --> SelfHealing: Failures Detected (Attempts < 3)
        SelfHealing --> RunTests: Fix Applied in Worktree
        Evaluate --> TestsPassed: All Tests Pass
        Evaluate --> TestsFailedExhausted: Max Retries Exceeded
    }

    Verification --> HunkReview: Deconstruct Diffs into Hunks
    
    state HunkReview {
        [*] --> DisplayHunks
        DisplayHunks --> InspectHunk: User Reviews Diff
        InspectHunk --> HunkAccepted: Click Accept
        InspectHunk --> HunkRejected: Click Reject
        InspectHunk --> HunkReprompt: Request Adjustment
        HunkReprompt --> AutonomousExecution: Targeted Feedback to TrueForge
        HunkAccepted --> CheckRemaining
        HunkRejected --> CheckRemaining
        CheckRemaining --> ReviewComplete: All Hunks Resolved
    }

    HunkReview --> PatchApplication: Apply Accepted Hunks to Base Branch
    PatchApplication --> PassportIssuance: Synthesize Patch Passport
    PassportIssuance --> PruneWorktree: Clean Worktree & Temp Branch
    PruneWorktree --> Complete: Done
    Complete --> [*]

    %% Cancellation paths
    RepositoryAnalysis --> Cancelled: User Clicks Cancel
    ContextRetrieval --> Cancelled: User Clicks Cancel
    TaskPlanning --> Cancelled: User Clicks Cancel
    AutonomousExecution --> Cancelled: User Clicks Cancel
    Verification --> Cancelled: User Clicks Cancel
    HunkReview --> Cancelled: User Clicks Cancel
    Cancelled --> PruneWorktree: Immediate Sandbox Dismantling
```

---

## 2. Detailed Phase Specifications

### Phase 1: User Request & Intent Parsing
1. Developer enters a natural language prompt via the PatchPilot VS Code Sidebar.
2. The `SessionManager` initializes a new session record in SQLite (`.patchpilot/session.db`) with status `INITIALIZED`.
3. An active `AbortController` is attached to the session context.

### Phase 2: Repository Analysis & Context Retrieval (RepoBrain)
1. TrueForge requests context related to the user prompt.
2. RepoBrain coordinates two discovery passes:
   - **Lexical Discovery:** Invokes `ripgrep` across the repository to locate direct keyword hits, class definitions, and function invocations.
   - **AST Structural Discovery:** Invokes Tree-sitter on candidate files to extract symbol relationships (e.g., class hierarchies, decorators, imports, call graphs).
3. Symbols are scored and ranked. High-relevance code slices are packaged into token-bounded context blocks and streamed to TrueForge.

### Phase 3: Task Planning
1. TrueForge digests the context and formulates a structured JSON execution plan.
2. The plan identifies:
   - Specific target files to modify.
   - Associated test suites to run.
   - Anticipated side effects.
3. The plan is displayed in the VS Code sidebar for developer transparency.

### Phase 4: Isolated Workspace Provisioning
1. `WorktreeManager` executes:
   ```bash
   git worktree add -b patchpilot/session-<id> .patchpilot/worktrees/wt-<id> HEAD
   ```
2. The isolated environment is verified. The developer's active workspace and uncommitted files remain completely untouched.

### Phase 5: Autonomous Multi-File Execution (TrueForge Loop)
1. TrueForge executes its model-driven loop, reading files from and writing modifications to the worktree directory.
2. Tool calls (read, write, delete, search) are executed through the Layer 4 tool harness.
3. Every step updates the session state in SQLite.

### Phase 6: Self-Healing Verification Loop
1. Once file edits are complete, PatchPilot executes the verification suite inside the worktree (e.g., `pytest tests/test_routing.py`).
2. **If all tests pass:** Test outputs, execution time, and coverage metrics are stored in the verification evidence record.
3. **If tests fail:**
   - Stack traces, error logs, and failure details are captured.
   - A specialized diagnostic message is fed back to the TrueForge agent loop:
     > *"Verification failed with exit code 1. Diagnostics: AssertionError at line 42 of test_routing.py. Please inspect the failure and provide self-correcting edits."*
   - TrueForge analyzes the diagnostic, applies targeted fixes to the worktree, and re-triggers verification.
   - Self-healing is bounded by a maximum threshold (default: 3 iterations) to prevent infinite loops and runaway token consumption.

### Phase 7: Hunk Intelligence & Human-in-the-Loop Review
1. PatchPilot runs `git diff HEAD` inside the worktree to generate the unified diff across all modified files.
2. The `HunkEngine` parses the unified diff into discrete, semantically contextualized hunks.
3. The custom **Hunk Review Webview** opens in VS Code, displaying:
   - Impacted file path and AST symbol context.
   - Unified side-by-side or inline diff with syntax highlighting.
   - Action buttons:
     - **Accept:** Mark hunk for inclusion.
     - **Reject:** Discard hunk; retain original code.
     - **Re-Prompt:** Enter natural language feedback to request TrueForge regenerate or adjust that specific hunk.

```mermaid
flowchart LR
    A["Raw Unified Diff<br/>(git diff HEAD)"] --> B["HunkEngine Parser"]
    B --> C["Hunk 1: Function Signature"]
    B --> D["Hunk 2: Route Decorator"]
    B --> E["Hunk 3: Unit Test Case"]

    C -->|Developer: Accept| F["Staged Patchset"]
    D -->|Developer: Reject| G["Discarded Hunk"]
    E -->|Developer: Accept| F

    F --> H["git apply --cached"]
    H --> I["Developer Working Tree Committed"]
```

### Phase 8: Patch Application & Workspace Cleanup
1. The accepted hunks are assembled into a synthesized patch and applied to the user's active branch:
   ```bash
   git apply --cached < synthesized_patch.patch
   git checkout -- . # sync working directory with index
   ```
2. The temporary worktree and branch are removed:
   ```bash
   git worktree remove --force .patchpilot/worktrees/wt-<id>
   git branch -D patchpilot/session-<id>
   ```

### Phase 9: Patch Passport Issuance
1. The `PatchPassportGenerator` compiles the final manifest containing:
   - Original user intent.
   - Model ID and TrueForge session telemetry.
   - Files and symbols modified.
   - Hunk review breakdown (accepted vs rejected).
   - Test execution evidence and logs.
   - SHA-256 integrity digest.
2. The manifest is stored in `.patchpilot/passports/<passport_id>.json` and rendered in the Patch Passport viewer.

---

## 3. Cancellation Architecture

Immediate, safe cancellation is an essential requirement of the Forge-a-thon.

```mermaid
sequenceDiagram
    autonumber
    actor Dev as Developer
    participant UI as VS Code UI
    participant CM as CancellationManager
    participant TF as TrueForge SDK
    participant Sub as Child Subprocesses (pytest / git)
    participant WT as Git Worktree

    Dev->>UI: Click "Cancel"
    UI->>CM: Trigger cancellation
    CM->>TF: Send AbortSignal (SIGINT)
    CM->>Sub: Terminate active PID (SIGTERM / SIGKILL)
    TF-->>CM: Acknowledge execution halt
    CM->>WT: git worktree remove --force
    WT-->>CM: Sandbox pruned
    CM->>UI: Update status: CANCELLED (zero residue)
```

1. **Immediate Halt:** When the user clicks Cancel, the `CancellationManager` signals the `AbortController`.
2. **Process Termination:** Any active child process (e.g., long-running `pytest` execution) receives `SIGTERM`, followed by `SIGKILL` if unresponsive within 2 seconds.
3. **Clean Teardown:** The temporary worktree and its branch are immediately removed, guaranteeing no lingering locks or dirty files.
4. **Zero Main Workspace Impact:** Because all edits were restricted to the worktree, the developer's working directory is 100% clean and unaffected.

---

## 4. Crash Recovery & Resumption Architecture

Network drops, model rate limits, or IDE crashes must never cause lost work or unrecoverable repository states.

```mermaid
flowchart TD
    Start["Extension Activates"] --> CheckDB["Query SQLite for Active Sessions"]
    CheckDB --> AnyActive{"Unfinished Sessions Found?"}
    AnyActive -- No --> Ready["Ready for New Tasks"]
    AnyActive -- Yes --> VerifyWT["Inspect Stored Worktree Path"]
    
    VerifyWT --> WTValid{"Worktree Exists & Git Clean?"}
    WTValid -- No --> CleanDB["Clean Stale DB Records -> Ready"]
    WTValid -- Yes --> PromptUser["Prompt Developer:<br/>'Interrupted Session Found. Resume or Discard?'"]
    
    PromptUser -- Discard --> Dismantle["Remove Worktree & Mark Session CANCELLED"]
    PromptUser -- Resume --> LoadCheckpoint["Load Last Valid Checkpoint from SQLite"]
    LoadCheckpoint --> ResumeStage["Resume Session at Saved State<br/>(e.g., Hunk Review or Verification)"]
```

1. **Monotonic Checkpoints:** Checkpoints are stored in SQLite at every stage transition:
   - `CHECKPOINT_PLAN_READY`
   - `CHECKPOINT_EDITS_APPLIED`
   - `CHECKPOINT_TESTS_COMPLETED`
   - `CHECKPOINT_REVIEW_IN_PROGRESS`
2. **Deterministic Resumption:** If VS Code restarts, PatchPilot detects the incomplete session, reads the last checkpoint payload, and offers the developer the option to resume directly from that step.
3. **Idempotence:** Every operation is designed so re-running from the last checkpoint does not duplicate file changes or create duplicate worktrees.
