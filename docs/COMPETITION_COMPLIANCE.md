# PatchPilot — Competition Compliance & Evaluation Guide

**Competition:** TrueFoundry Forge-a-thon — Techfest, IIT Bombay  
**Target Category:** Editor-Native Coding Agent (VS Code Extension)  
**Agent Harness:** TrueForge (`@truefoundry/trueforge-sdk`)  
**Demonstration Repository:** `pallets/flask`

---

## 1. Compliance Traceability Matrix

The table below maps every competition requirement established by TrueFoundry and Techfest IIT Bombay directly to PatchPilot's architectural design and implementation status.

| Competition Requirement | Evaluation Criteria | PatchPilot Architectural Enforcement | Implementation Status |
| :--- | :--- | :--- | :--- |
| **1. TrueForge-Only Loop** | The agent execution loop must run strictly on TrueForge. No independent model-driven loops. | **Strict Architectural Mandate:** TrueForge owns the autonomous agent loop. PatchPilot implements the VS Code UI, local tool harness (RepoBrain, Git worktrees, test runner), and evidence logging. All reasoning and planning pass through `@truefoundry/trueforge-sdk`. | Architecture Proposed & Documented; Implementation Pending |
| **2. Editor-Native Extension** | Must be implemented as a Visual Studio Code extension. | Implemented using the standard VS Code Extension API (`^1.90.0`), featuring Custom Webviews for Chat, Hunk Review, and Patch Passport. | Architecture Proposed & Documented; Implementation Pending |
| **3. Large Repository Handling** | Must navigate large real-world repositories without context exhaustion. | Evaluated against `pallets/flask`. RepoBrain couples Tree-sitter AST symbol extraction with `ripgrep` lexical search to construct token-compact context slices. | Architecture Proposed & Documented; Implementation Pending |
| **4. Autonomous Multi-File Edits** | Must execute multi-file modifications without manual file-by-file prompting. | TrueForge agent plans and executes cross-file edits transactionally inside an isolated Git worktree. | Architecture Proposed & Documented; Implementation Pending |
| **5. Hunk-by-Hunk Review** | Must provide safe, granular diff inspection prior to committing. | Custom Hunk Review Webview decomposes unified diffs into semantic hunks, enabling per-hunk `[Accept]`, `[Reject]`, and `[Re-prompt]` decisions. | Architecture Proposed & Documented; Implementation Pending |
| **6. Model Failure Recovery** | Must demonstrate resilience against model timeouts, failures, or bad tool calls. | SQLite-backed monotonic checkpointing engine (`.patchpilot/session.db`) allows deterministic resumption. Self-healing loop automatically feeds test errors back to TrueForge. | Architecture Proposed & Documented; Implementation Pending |
| **7. Immediate Cancellation** | Must support immediate cancellation of long-running operations. | `CancellationManager` dispatches `AbortSignal` to TrueForge SDK, sends `SIGINT`/`SIGTERM` to active subprocesses, and dismantles temporary worktrees with zero residual pollution. | Architecture Proposed & Documented; Implementation Pending |
| **8. Flask Demonstration** | Must demonstrate proficiency on three fixed tasks in `pallets/flask`. | Automated test validation against official Flask test suite (`pytest`) across three core scenarios. | Benchmark Protocol Established; Demonstration Pending Implementation |

---

## 2. The Primary Demonstration Repository: `pallets/flask`

The TrueFoundry Forge-a-thon designates **`pallets/flask`** as the primary evaluation target. `pallets/flask` is an ideal testbed because:
- It represents a mature, widely used open-source Python framework.
- It possesses a complex cross-file architecture spanning core routing, context locals, sans-I/O scaffolding, and Blueprint registration.
- It maintains a comprehensive test suite (`pytest`) with high test coverage, strict type hinting, and established documentation conventions.

### Official Demonstration Scenarios
Without fabricating unreleased task prompts, PatchPilot is evaluated across three core engineering categories:

1. **Task Scenario 1 — Cross-Module Feature Enhancement / Refactoring:**
   - Involves modifying routing logic or Blueprint handling across multiple files (e.g., `src/flask/sansio/scaffold.py`, `src/flask/blueprints.py`).
   - Requires updating associated unit test cases in `tests/test_routing.py` or `tests/test_blueprints.py`.
   - Demonstrates: Autonomous multi-file planning, worktree isolation, and self-healing when initial tests fail.

2. **Task Scenario 2 — Bug Fix with Regression Testing:**
   - Addresses a subtle edge case in request handling, error formatting, or cookie handling.
   - Requires introducing a targeted fix and adding a new regression test case.
   - Demonstrates: AST symbol navigation in RepoBrain, precise diff generation, and hunk-level acceptance.

3. **Task Scenario 3 — Context-Aware Multi-File Typing & Documentation:**
   - Involves updating type annotations and docstrings across several core modules.
   - Evaluates: Handling cancellation midway through execution to prove zero workspace pollution, followed by successful checkpoint recovery.

---

## 3. Four-Minute Competition Demonstration Protocol

The Forge-a-thon Round 1 video submission requires a strict 4-minute technical walkthrough:

```mermaid
timeline
    title 4-Minute Demonstration Video Schedule
    0:00 - 0:45 : Architecture & Workspace Cleanliness : Present TrueForge sole-loop architecture; show clean pallets/flask repo with existing uncommitted developer files.
    0:45 - 1:45 : Task 1 Execution & Isolation : Prompt agent with Task 1; RepoBrain extracts symbols; TrueForge generates plan; isolated worktree created.
    1:45 - 2:45 : Verification & Hunk Intelligence : Run pytest in worktree; simulate test failure & agent self-healing; open Hunk Review UI for selective accept/reject.
    2:45 - 3:30 : Tasks 2 & 3 & Cancellation : Execute Task 2 bugfix; trigger Task 3 and click Cancel; demonstrate instant SIGINT teardown & zero residue.
    3:30 - 4:00 : Patch Passport Audit : Open generated Patch Passport; inspect prompt, diffs, test logs, and TrueForge token telemetry.
```

### Protocol Guidelines:
- **No Fabricated Outcomes:** Demonstration records real executions against `pallets/flask` test suites.
- **Proof of Isolation:** Visual demonstration in VS Code that uncommitted developer edits on the `main` branch are neither overwritten nor committed.
- **Proof of Verification:** Visual inspection of `pytest` logs and exit codes within the Patch Passport manifest.

---

## 4. Evaluation Rubric Alignment

| Evaluation Category | Key Differentiators Showcased |
| :--- | :--- |
| **Agent Autonomy & Reasoning** | TrueForge-driven multi-step planning, automated file reading, and contextual tool usage. |
| **Developer Ergonomics & Control** | Granular hunk-by-hunk review in VS Code; developer retains final veto over every individual code change. |
| **System Reliability & Safety** | Zero-pollution Git worktrees, SQLite session checkpoints, and immediate cancellation guarantees. |
| **Transparency & Auditability** | Tamper-evident Patch Passport providing an immutable receipt of agent and test provenance. |
