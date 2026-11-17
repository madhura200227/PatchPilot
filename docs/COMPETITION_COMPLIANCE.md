# PatchPilot — Competition Compliance & Evaluation Guide

**Competition:** TrueFoundry Forge-a-thon — Techfest, IIT Bombay  
**Target Category:** Editor-Native Coding Agent (VS Code Extension)  
**Agent Harness:** TrueForge (`@truefoundry/trueforge-sdk`)  
**Demonstration Repository:** `pallets/flask`  
**Documentation Authority:** Subordinate to [docs/PRD.md](file:///e:/MADHURA/PROJECTS%20madhura/PatchPilot/docs/PRD.md)

---

## 1. Competition Requirements Classification

To maintain strict compliance and technical honesty, all statements regarding the competition are categorized into four distinct levels of authority:

### Category A: Confirmed Official Competition Requirements
*Source: Official Techfest Competition Listing (<https://techfest.org/competitions/forge-a-thon>)*

1. **Eligibility & Team Size:** Open to participants aged 18+; teams of up to 5 members.
2. **Registration:** Mandatory online registration via Techfest portal to obtain a valid Team ID.
3. **Key Deadlines:**
   - Registration: 15 October – 15 November 2026
   - Round 1 Submission: 20 November 2026, 23:59 IST
   - Round 1 Results: 30 November 2026
   - Round 2 Finals (On-site at IIT Bombay): 16 – 18 December 2026
4. **Prize Pool:** ₹3,00,000 total prize pool.
5. **Round 1 Submission Deliverables:**
   - Public GitHub repository.
   - 1–3 page technical write-up in PDF format.
   - Public demonstration video of maximum 4 minutes.
   - Execution of three fixed tasks (Tasks A, B, and C) on `pallets/flask`.
6. **Core Runtime Mandate:** Agent loops must run strictly on **TrueForge**.
7. **Model Configuration:** Models must be configured through TrueForge and declared in the write-up.
8. **Originality & Licensing:** Code must be original or use properly licensed open-source forks with attribution.
9. **Core Product Capabilities:**
   - Navigating and understanding large repositories.
   - Autonomous, unprompted multi-file code modifications.
   - Hunk-by-hunk diff review.
   - Reliability under model failures.
   - Immediate cancellation capability.
10. **Judges' Authority:** Decisions of organizers and judges are final and binding.

### Category B: Requirements Derived from Official TrueForge Architecture
*Source: Official TrueForge Documentation (<https://github.com/truefoundry/trueforge>)*

1. **Sole Loop Authority:** TrueForge owns model calls, tool dispatch, context management, and session state. The extension must not run a secondary model loop.
2. **Client Bridge:** Official TypeScript SDK (`@truefoundry/trueforge-sdk`) connects the extension to the TrueForge server/daemon.
3. **Tool Model:** Tools are exposed to TrueForge via Model Context Protocol (MCP) or native tool definitions.
4. **Token Optimization:** Relies on TrueForge's context compaction mechanism to handle token limits in large repositories.
5. **Human Checkpoints:** Interactive tool approvals and user decisions are handled through TrueForge-supported human checkpoint mechanisms.

### Category C: Proposed PatchPilot Engineering Decisions
*Source: PatchPilot Technical Design (Internal Architecture — Not Competition Mandates)*

1. **Git Worktree Isolation:** Using temporary Git worktrees (`.patchpilot/worktrees/wt-<id>`) to keep developer working trees clean during execution.
2. **Hunk Intelligence Engine:** Custom diff decomposition and Webview interface for selective hunk staging.
3. **RepoBrain Staged Retrieval:** Combining `ripgrep` lexical search (P0) with Tree-sitter AST symbol extraction (P1).
4. **SQLite Checkpoint Store:** Embedded SQLite database (`.patchpilot/session.db`) for extension-side session, hunk, and recovery persistence.
5. **Patch Passport Manifest:** Standardized JSON evidence receipt capturing user prompt, plan, diffs, test logs, and review decisions.
6. **Bounded Self-Healing Loop:** Running `pytest` inside the worktree and feeding error diagnostics back to TrueForge (maximum 3 retry attempts).

### Category D: Unverified Assumptions & Items Awaiting Organizer Confirmation
*Status: Open Decisions Register (PRD Section 27)*

| ID | Item | Status | Action Required |
| :--- | :--- | :--- | :--- |
| **OD-01** | Exact wording and acceptance criteria for **Task A** | Awaiting Organizer Material | Do not invent task prompt; use generic fixture for internal testing only. |
| **OD-02** | Exact wording and acceptance criteria for **Task B** | Awaiting Organizer Material | Do not invent task prompt; use generic fixture for internal testing only. |
| **OD-03** | Exact wording and acceptance criteria for **Task C** | Awaiting Organizer Material | Do not invent task prompt; use generic fixture for internal testing only. |
| **OD-04** | Allowed TrueForge deployment topology during evaluation (local, self-hosted, or cloud) | Awaiting Organizer Clarification | Support local daemon configuration as default; query organizers. |
| **OD-05** | Workspace transport: MCP bridge vs mounted/synced container sandbox | Architecture Spike Pending | Evaluate during Milestone 0. |
| **OD-06** | Exact SDK version and cancellation API methods | Awaiting Pinned SDK Spike | Validate against installed `@truefoundry/trueforge-sdk`. |
| **OD-07** | Permitted model providers and API key constraints during judging | Team Decision / Clarification | Disclose selected models in submission write-up. |
| **OD-08** | Final team member roles and attribution | Team Decision | Confirm before submission. |
| **OD-09** | Detailed official judging rubric and scoring weights | Not Established from Public Page | Design for balanced excellence across all capabilities; do not fabricate weights. |
| **OD-10** | Final public repository URL | Pending Confirmation | Verify repository accessibility before deadline. |

---

## 2. The Primary Demonstration Target: `pallets/flask`

The TrueFoundry Forge-a-thon designates **`pallets/flask`** as the primary evaluation target.

### Official Task Status
- **Tasks A, B, and C:** The exact official task prompts, target files, and acceptance criteria have **not been publicly released** on the competition portal.
- **Pre-Competition Testing Policy:** The team must **not invent or guess** official prompts. For internal engineering rehearsal prior to official prompt release, the team uses synthetic test fixtures against `pallets/flask` to validate:
  1. Multi-file navigation and editing across core modules (e.g., `scaffold.py`, `blueprints.py`, `app.py`).
  2. Test execution and failure diagnostics using Flask's test suite (`pytest tests/`).
  3. Immediate cancellation and worktree cleanup during active tool execution.

Once official prompts for Tasks A, B, and C are published by organizers, this section and corresponding test fixtures will be updated to record the exact official text.

---

## 3. Four-Minute Demonstration Structure (Provisional Allocation)

The competition requires a video submission of no more than four minutes demonstrating Tasks A, B, and C on `pallets/flask`. The timing below represents a provisional storytelling plan:

| Time | Demonstration Segment | Content & Integrity Rules |
| :--- | :--- | :--- |
| **0:00 – 0:15** | **Problem & Architecture** | Introduce PatchPilot, TrueForge runtime integration, and the problem of unverified AI modifications. |
| **0:15 – 1:00** | **Official Task A** | Demonstrate repository understanding and multi-file planning on `pallets/flask` using official Task A prompt. |
| **1:00 – 1:45** | **Official Task B** | Demonstrate autonomous multi-file editing and Hunk Intelligence review on official Task B. |
| **1:45 – 2:30** | **Official Task C** | Demonstrate task execution and automated test verification (`pytest`) on official Task C. |
| **2:30 – 3:30** | **Resilience: Cancellation & Recovery** | Demonstrate immediate cancellation (showing worktree teardown) and idempotent checkpoint recovery. |
| **3:30 – 4:00** | **Patch Passport Audit** | Inspect the generated Patch Passport manifest, showing factual test logs and review decisions. |

### Integrity Rules for Demonstration:
- All demonstrations must show actual TrueForge runtime executions; no simulated or mocked events.
- Test logs must reflect actual execution outcomes (distinguishing passed, failed, and not-run).
- Demonstrations must show clean developer workspace preservation.

---

## 4. Evaluation Rubric & Compliance Summary

Because official scoring weights are not published on the public competition page (OD-09), PatchPilot is engineered to satisfy all stated functional expectations equally:

| Area | Competition Expectation | PatchPilot Architectural Response |
| :--- | :--- | :--- |
| **Runtime Compliance** | Strict execution on TrueForge. | TrueForge executes the sole agent loop; client uses `@truefoundry/trueforge-sdk`. |
| **Repository Scale** | Effective navigation of `pallets/flask`. | RepoBrain provides staged context retrieval; relies on TrueForge context compaction. |
| **Modification Safety** | Safe multi-file changes without polluting user work. | Isolated Git worktrees keep main working tree untouched until explicit review approval. |
| **Review Granularity** | Hunk-by-hunk diff review. | Custom Webview enables selective accept/reject/re-prompt per individual code hunk. |
| **Reliability** | Stability under failures and cancellations. | SQLite checkpointing enables recovery; cancellation signals halt execution and prune worktrees. |
| **Evidence & Traceability** | Verifiable task completion. | Patch Passport manifest bundles intent, diffs, test logs, and review records. |
