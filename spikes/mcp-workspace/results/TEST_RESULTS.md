# PatchPilot: Controlled Workspace Access & TrueForge MCP Integration Test Results

**Date:** 17 November 2026  
**Repository:** [madhura200227/PatchPilot](https://github.com/madhura200227/PatchPilot)  
**Branch:** `spike/mcp-workspace-access`  
**Starting Commit SHA:** `7bb5e98000b39557f987fdace2bf963501ae0fb7`  
**Server Target:** Local TrueForge v0.185.1 Standalone Daemon (`http://localhost:8790`)  
**Pinned SDK Package:** `@truefoundry/trueforge-sdk@0.185.0`  
**Pinned MCP SDK:** `@modelcontextprotocol/sdk@1.32.2`  
**Primary Transport:** `StreamableHTTPServerTransport` (`streamable-http`)  
**Fallback Transport:** `SSEServerTransport` (`sse`)  
**Network Security Configuration:** `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1", "localhost"]'`  

---

## 1. Executive Verification Summary Table

| Category | Test Case | Target / Assertion | Status | Empirical Evidence |
| :--- | :--- | :--- | :--- | :--- |
| **Security** | Path Traversal Read | `read_workspace_file("../../../package.json")` | **PASS** | Rejected with `SecurityError: traverses outside configured workspace boundary`. |
| **Security** | Path Traversal Write | `write_workspace_file("../escape.txt", ...)` | **PASS** | Rejected; zero external files created. |
| **Security** | Absolute Path Outside Root | `read_workspace_file("C:\Windows\...")` | **PASS** | Traversal check rejected non-contained absolute path. |
| **Security** | Windows Drive Letter Escape | `read_workspace_file("D:\data")` | **PASS** | Rejected drive letter escape outside fixture root. |
| **Security** | Symlink Escape Check | Symlink pointing outside workspace root | **PASS** | `fs.realpathSync` detection triggered `Symlink Escape Denied`. |
| **Security** | Missing Auth Header | POST `/mcp` without `Authorization` | **PASS** | Immediate HTTP 401 Unauthorized (`WWW-Authenticate: Bearer`). |
| **Security** | Invalid Token | POST `/mcp` with invalid Bearer token | **PASS** | Immediate HTTP 401 Unauthorized. |
| **Security** | Oversized Payload (>1MB) | `write_workspace_file` with 1.5MB buffer | **PASS** | Rejected with `Content size exceeds maximum allowed limit`. |
| **Security** | Disallowed File Extensions | `.exe`, `.bat`, `.cmd`, `.sh`, `.ps1`, `.env` | **PASS** | Blocked by extension allowlist guard. |
| **Security** | Command Injection in Tests | `tests/calc.test.mjs; whoami` | **PASS** | `shell: false` and strict path resolution prevented execution. |
| **Security** | Test Timeout Protection | Infinite loop test with 1000ms timeout | **PASS** | Process terminated promptly at 1050ms; reported failed. |
| **Security** | Concurrent Write Integrity | 10 parallel file writes | **PASS** | All 10 writes completed with deterministic hashes. |
| **Security** | Boundary Containment | SHA-256 fingerprint of PatchPilot host repo | **PASS** | Pre- and post-test fingerprints identical (0 files modified). |
| **MCP Protocol** | Tool Discovery (`tools/list`) | Query tool manifest over Streamable HTTP | **PASS** | Discovered all 5 tools with complete Zod/JSON schemas. |
| **MCP Protocol** | Workspace File Listing | `list_workspace_files(".")` | **PASS** | Listed fixture files; internal `.git` directory excluded. |
| **MCP Protocol** | File Read & Hash Verification | `read_workspace_file("src/calculator.ts")` | **PASS** | Returned code content + authoritative 64-char hex SHA-256 hash. |
| **MCP Protocol** | Deterministic Bug Detection | `run_workspace_tests()` on initial fixture | **PASS** | Test failed with exitCode 1; captured `-1 !== 5` failure. |
| **MCP Protocol** | Workspace File Modification | `write_workspace_file("src/calculator.ts")` | **PASS** | Replaced buggy subtraction with `return a + b;`. |
| **MCP Protocol** | Test Suite Re-Execution | `run_workspace_tests()` post-fix | **PASS** | Test passed with exitCode 0; captured 1 pass, 0 fails. |
| **MCP Protocol** | Git Status Tracking | `get_workspace_status()` | **PASS** | Reported `clean: false`, `modifiedFiles: ["src/calculator.ts"]`. |
| **MCP Protocol** | Unknown Tool Rejection | Call `unauthorized_arbitrary_command` | **PASS** | Returned JSON-RPC error contract `{ isError: true }`. |
| **Extension Adapter**| Lifecycle Management | Start, check health, stop adapter | **PASS** | Managed dynamic port, generated secret token, reported status. |
| **Extension Adapter**| Loopback Enforcement | Refuse binding to non-loopback | **PASS** | Throws `SecurityError` if host is not `127.0.0.1`/`localhost`. |
| **Workspace Isolation**| Disposable Fixture Reset | `resetFixture()` via Git hard reset | **PASS** | Untracked files deleted; status returned to `CLEAN`. |
| **Cancellation** | Client Stream Cancellation | `AbortController.abort()` on SSE stream | **PASS** | Stream cleanly terminated with `AbortError` in 68ms. |
| **Cancellation** | TrueForge Turn Cancellation | `client.sessions.cancel(sessionId)` | **PASS** | TrueForge accepted server-side cancel request. |
| **Cancellation** | Process Termination on Cancel| Abort active test execution via signal | **PASS** | Process killed promptly within 164ms with exit code 130. |
| **Cancellation** | Post-Cancel Write Guard | Attempt write to cancelled turn | **PASS** | Prevented; no files modified after turn cancellation. |
| **TrueForge Integration**| SSRF Allowlist Compatibility | `PUT /api/v1/settings/mcp-servers` | **PASS** | HTTP 200 returned; `auth_status: "authenticated"`. |
| **TrueForge Integration**| Server-Side Tool Discovery | `GET /api/v1/mcp-servers/:name/tools` | **PASS** | TrueForge server queried local MCP server and listed 5 tools. |
| **TrueForge Integration**| Auth Header Propagation | Bearer token received from TrueForge | **PASS** | Verified TrueForge sent configured Bearer token to local MCP. |
| **TrueForge Integration**| Agent Autonomous Execution | End-to-end model agent tool invocation | **BLOCKED**| Model provider (OpenAI) returned 401 (invalid upstream key). |
| **Sandbox Execution** | Container Sandbox Cancellation | Kill running container process | **NOT VERIFIED**| Standalone TrueForge mode runs without Daytona/Docker daemon. |

---

## 2. Detailed Findings by Category

### A. Security & Path Traversal Verification
All path resolutions flow through `resolveSafeWorkspacePath()` in `pathGuard.ts`.
- **Traversal Resistance:** `../` relative sequences, drive letters (`D:\...`), and absolute roots are resolved to absolute normalized paths and checked against the normalized fixture root.
- **Symlink Protection:** Before any read or write, `fs.realpathSync` inspects existing files and parent directory chains. Any symlink resolving outside the fixture boundary is rejected.
- **Executable Protection:** Attempts to write `.exe`, `.bat`, `.cmd`, `.sh`, `.ps1`, `.env`, or `.key` are blocked with `Disallowed File Extension`.

### B. Direct MCP Protocol & Transport Execution
Testing against the local server using `@modelcontextprotocol/sdk/client/streamableHttp.js`:
- Client successfully executed the Streamable HTTP transport handshake over `http://127.0.0.1:<port>/mcp`.
- Tool calls were executed with full request/response validation:
  1. `list_workspace_files`: Returned all fixture entries while suppressing `.git`.
  2. `read_workspace_file`: Returned content and SHA-256 hash `d7301d0a...`.
  3. `run_workspace_tests`: Failed on the deliberate bug (`add(2, 3)` returned `-1`).
  4. `write_workspace_file`: Replaced bug with correct addition `return a + b;`.
  5. `run_workspace_tests`: Passed cleanly with exit code 0.
  6. `get_workspace_status`: Reported `src/calculator.ts` as modified.

### C. TrueForge Server Integration & SSRF Guard Verification
1. **SSRF Guard Behavior:** When TrueForge ran with default settings, `PUT /api/v1/settings/mcp-servers` failed with `400: Outbound URL blocked for host "127.0.0.1"`.
2. **Explicit Allowlist Resolution:** Configuring `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1", "localhost"]'` allowed loopback MCP registration while keeping global SSRF protection active against metadata (`169.254.169.254` still returns 400).
3. **TrueForge Tool Discovery:** TrueForge server executed GET `/api/v1/mcp-servers/patchpilot-workspace/tools`. TrueForge's internal `remoteMcpClient` connected, sent `Authorization: Bearer <token>`, queried `tools/list`, and returned all 5 tools with exit code 200.
4. **End-to-End Agent Turn Status:** When TrueForge dispatched the agent turn to repair the calculator, the turn failed with `[Model Error] (401): Incorrect API key provided`. Pursuant to Section 7 rules, this test is classified strictly as **BLOCKED**, proving the execution boundary without falsifying autonomous model results.

### D. Cancellation Semantics Across 4 Layers
1. **Layer 1 (Client SSE Stream):** Passing an `AbortSignal` to the client SSE stream aborts within 68ms with `AbortError`.
2. **Layer 2 (TrueForge Server Turn):** Calling `client.sessions.cancel(sessionId)` transitions the turn to `cancelled`.
3. **Layer 3 (Tool Subprocess Termination):** When an active test run is interrupted via `AbortSignal`, the underlying `execFile` child process is immediately terminated via `SIGTERM` within 164ms and exits with code 130.
4. **Layer 4 (Post-Cancellation Write Guard):** Any attempt to dispatch file writes under a cancelled turn context is prohibited.

---

## 3. Classification Summary

- **Total Test Cases Executed:** 33
- **PASS:** 31
- **BLOCKED:** 1 (Autonomous model agent turn execution due to upstream LLM 401 key)
- **NOT VERIFIED:** 1 (Daytona/Docker container sandbox process kill)
- **FAIL:** 0
