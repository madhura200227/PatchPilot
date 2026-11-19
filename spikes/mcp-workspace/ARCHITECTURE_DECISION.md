# PatchPilot: Architecture Decision Record (ADR)
## Controlled Workspace Access & TrueForge Integration Strategy

**Status:** APPROVED  
**Date:** 17 November 2026  
**Context:** Milestone 0 / Prompt 005 Architectural Proof  
**Authors:** PatchPilot Infrastructure & Security Engineering  

---

## 1. Problem Statement

PatchPilot enables AI-assisted repository repair and patch generation powered by the TrueForge agent runtime. To perform code inspection, fault localization, test execution, and repair verification, the TrueForge agent requires read, write, and test-running capabilities on the user's codebase.

The central architectural dilemma:
> **How can PatchPilot safely expose a workspace to a TrueForge agent, allowing inspection, modification, and test verification, while keeping the user's actual working tree protected from unauthorized access, symlink escapes, unreviewed file mutations, and remote SSRF vulnerabilities?**

---

## 2. Architectural Candidates Evaluated

### Architecture A: Local Authenticated MCP Server (Bound to Git Worktree)

In this model, the PatchPilot VS Code extension spawns a local, out-of-process HTTP/SSE MCP server on loopback (`127.0.0.1:<ephemeral-port>`). The MCP server exposes deterministic tools (`list_workspace_files`, `read_workspace_file`, `write_workspace_file`, `run_workspace_tests`, `get_workspace_status`) strictly confined to an isolated Git worktree directory (`.patchpilot/worktrees/<task-id>/`). TrueForge connects directly to this server as a remote MCP connector using `streamable-http`.

### Architecture B: TrueForge Managed Sandbox Execution with Workspace Synchronization

In this model, TrueForge runs tools inside an isolated container (Docker or Daytona). PatchPilot synchronizes the repository files into the container via Git clone or tarball upload before the turn begins. The agent executes shell commands and file modifications entirely inside the container. After completion, PatchPilot pulls modified files or git diffs back from the container via TrueForge's `downloadSandboxFile` API.

### Architecture C: Reverse Tunnel / Webhook Proxy to Extension Host

In this model, the VS Code extension registers a WebSocket or tunnel connection to a hosted TrueForge cluster, proxying workspace commands back through the VS Code Extension Host filesystem API (`vscode.workspace.fs`).

---

## 3. Detailed Trade-off Evaluation Matrix

| Evaluation Dimension | Architecture A: Local Authenticated MCP Server | Architecture B: TrueForge Sandbox Sync | Architecture C: Extension Reverse Proxy |
| :--- | :--- | :--- | :--- |
| **Security & Containment** | **HIGH**: Filesystem access strictly governed by path traversal guards, extension allowlists, and realpath symlink checks. Host repo is never touched. | **HIGH**: Full OS/filesystem container isolation. Escape requires container breakout. | **MEDIUM**: Exposes VS Code Extension Host file APIs; higher attack surface if token leaks. |
| **Local Development UX** | **EXCELLENT**: Zero Docker requirement; works immediately on any developer workstation (Node 22+). Instant test feedback. | **POOR ON WINDOWS**: TrueForge local sandbox fallback is explicitly unsupported on Windows (`LocalSandboxProvider supports macOS and Linux only (got win32)`). Requires full Docker/Daytona daemon. | **MODERATE**: Requires outbound tunnel or proxy daemon. |
| **Implementation Complexity** | **LOW-MEDIUM**: Clean MCP protocol standard (`@modelcontextprotocol/sdk`). Minimal footprint. | **HIGH**: Staging synchronizer, tarball diffing, conflict resolution, container lifecycle management. | **HIGH**: Stateful connection keepalives, tunnel reliability, protocol framing. |
| **Test Execution Fidelity** | **HIGH**: Tests execute in the user's native environment with local compilers, runtime versions, and system libraries. | **MEDIUM**: Container may lack user's specific system dependencies, native binaries, or hardware access. | **LOW**: Running test processes directly through Extension Host is constrained by Electron Node environment. |
| **File Synchronization Overhead**| **ZERO**: Direct read/write to the isolated local worktree; no file upload or download latency. | **HIGH**: Full tree sync before turn, diff download after turn. Large repositories incur heavy bandwidth and latency penalties. | **MEDIUM**: Per-file remote RPC roundtrips. |
| **Cancellation Responsiveness** | **FAST**: Direct `AbortSignal` propagation terminates child test processes within <200ms. | **SLOW**: Container process kill requires container daemon intervention; standalone mode cannot kill running container processes. | **MODERATE**: Depends on tunnel socket teardown. |
| **TrueForge Alignment** | **NATIVE**: Uses official TrueForge remote MCP connector (`PUT /api/v1/settings/mcp-servers`) and standard `streamable-http` transport. | **NATIVE**: Uses TrueForge's built-in Daytona/TFYSandboxProvider architecture. | **CUSTOM**: Bypasses TrueForge tool conventions; requires custom agent tools. |
| **Hosted TrueForge Suitability** | **REQUIRES MESH/TUNNEL**: In hosted multi-tenant deployments, `127.0.0.1` cannot be reached directly without an authenticated sidecar tunnel or VPC peering. | **EXCELLENT FOR HOSTED**: Cloud-native containers run natively inside Kubernetes or TrueFoundry clusters. | **MODERATE**: Tunnel must traverse cloud ingress. |

---

## 4. Key Empirical Findings from Prompt 005 Spike

1. **SSRF Allowlist Viability:**  
   The earlier localhost SSRF block was successfully resolved without globally disabling security. TrueForge's authoritative configuration `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1", "localhost"]'` explicitly allows loopback MCP connections while maintaining active rejection against cloud metadata endpoints (`169.254.169.254` returns 400).
2. **TrueForge Remote MCP Client Behavior:**  
   TrueForge server successfully connects over `streamable-http`, passes Bearer authentication headers, discovers all 5 registered tools (`GET /api/v1/mcp-servers/:name/tools`), and attaches them to agent sessions.
3. **Failsafe Workspace Isolation:**  
   Empirical testing with 33 test cases proved that the host PatchPilot repository files sustained **0 mutations** across aggressive read, write, traversal, and test operations. The disposable fixture was cleanly modified, verified via tests, and restored to its clean git commit via `resetFixture()`.
4. **Platform Restriction of Local Sandboxes:**  
   TrueForge server logs confirmed:
   `"Local sandbox fallback is unavailable: LocalSandboxProvider supports macOS and Linux only (got win32)"`.  
   This makes Architecture B non-viable for standalone local development on Windows developer machines without Docker Desktop.

---

## 5. Architectural Recommendation

### Recommended Architecture: **Architecture A (Local Authenticated MCP Server bound to Git Worktrees)**

We recommend **Architecture A** as the primary production architecture for PatchPilot local development, paired with a hybrid path for hosted environments:

1. **Local Development Mode (Primary):**
   - The PatchPilot extension launches an isolated, authenticated MCP server on `127.0.0.1`.
   - The server is strictly bound to an isolated Git worktree (`.patchpilot/worktrees/<task-id>/`), protecting the developer's working directory.
   - TrueForge interacts via standard `streamable-http` with explicit development loopback allowlisting.
   - Tests execute with local fidelity and immediate cancellation response.
2. **Hosted / Remote Mode (Future Milestone):**
   - When connecting to a hosted TrueForge instance in the cloud, PatchPilot will package the worktree into a containerized sidecar or secure mTLS tunnel, reusing the exact same MCP tool schemas and security boundaries validated in this spike.

---

## 6. Next Steps & Progression to Milestone 1

With the controlled workspace access boundary and TrueForge MCP integration proven empirically:
- **RepoBrain Indexing:** Safe to begin AST / Tree-sitter indexing without risk of workspace corruption.
- **Git Worktree Manager:** Implement the production worktree supervisor creating isolated worktree branches from `HEAD`.
- **Patch Passport & Hunk Review:** Enforce human review gates before applying any worktree patch to the developer's primary working branch.

---

## 7. Addendum — Promotion to Production Extension MVP (Prompt 007)

*Updated for `feature/forgeathon-mvp` while preserving the Prompt 005 historical evidence above:*

- **Production Integration:** The local authenticated MCP server pattern validated in this spike has been promoted into the production VS Code extension under `src/workspace/` (`mcpServerCore.ts`, `mcpServerEntry.ts`, `WorkspaceProcessManager.ts`, `WorkspaceMcpAdapter.ts`, `proposalStore.ts`, `executionOverlay.ts`, `patchEngine.ts`, `hunkReview.ts`, `undoManager.ts`) and `src/security/` (`pathGuard.ts`, `secretFilter.ts`, `commandPolicy.ts`), bundled as `dist/mcpServer.js`.
- **Security Hardening Applied:** Closed the spike's blanket dotfile bypass (`ALLOWED_DOTFILES` allowlist), replaced broad test-file execution with strict per-executable argument policies in `commandPolicy.ts`, replaced direct workspace writes with proposal-only `propose_edit` + disposable execution overlays, and added per-session Streamable HTTP transports.
- **Verification Status:** Out-of-process MCP startup inside a real VS Code Extension Development Host (`1.146.0`), TrueForge v0.185.1 connector registration & 8-tool discovery, agent context-engineering persistence (`preload: false`, `compaction`, `largeToolResponse`, literal tool approvals), hunk review/apply/undo, and Task C resilience are verified. Live model-backed end-to-end execution remains `BLOCKED` until a valid upstream model provider credential is configured in TrueForge; accordingly, Architecture A remains a **verified infrastructure candidate pending live provider-backed agent proof**.
