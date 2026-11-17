# PatchPilot: Controlled Workspace Access & TrueForge MCP Integration Spike

This directory contains the executable architectural proof for **Prompt 005**, validating how PatchPilot safely exposes an isolated repository workspace to a TrueForge agent via an authenticated Model Context Protocol (MCP) server while keeping the user's primary working repository protected.

---

## 1. System Architecture

```text
┌────────────────────────────────────────────────────────────────────────┐
│                   PatchPilot VS Code Extension Host                   │
│                                                                        │
│   ┌───────────────────────────┐      ┌─────────────────────────────┐   │
│   │   WorkspaceMcpAdapter     │      │   TrueForge Client SDK      │   │
│   │  - Lifecycle orchestration│      │   @truefoundry/             │   │
│   │  - Dynamic secret gen     │      │   trueforge-sdk@0.185.0     │   │
│   │  - Health probing         │      └──────────────┬──────────────┘   │
│   └─────────────┬─────────────┘                     │                  │
└─────────────────┼───────────────────────────────────┼──────────────────┘
                  │ Spawns & supervises               │ HTTP REST / SSE
                  ▼                                   ▼
┌───────────────────────────────────┐  ┌─────────────────────────────────┐
│ PatchPilot Local Workspace MCP    │  │ TrueForge Agent Server Daemon   │
│ - Node HTTP + StreamableHTTP      │  │ - Standalone v0.185.1           │
│ - Bound strictly to 127.0.0.1     │  │ - Port 8790                     │
│ - Bearer Token Auth required      │  │ - OUTBOUND_URL_ALLOWED_HOSTS    │
│ - Path confinement & symlink check│  │ - SSRF Guard active             │
│ - Fixed test runner (node --test) │  │ - Remote MCP Connector Client   │
└─────────────────┬─────────────────┘  └──────────────┬──────────────────┘
                  │                                   │
                  │   Direct MCP Connection (HTTP)    │
                  ◄───────────────────────────────────┘
                  │   Bearer sec-patchpilot-...
                  │
                  ▼
┌────────────────────────────────────────────────────────────────────────┐
│         Isolated Disposable Test Fixture (%TEMP%/patchpilot-...)        │
│  - src/calculator.ts (intentional bug: subtraction in add())           │
│  - tests/calculator.test.mjs (deterministic test suite)                │
│  - .git repository (cleanly resettable to initial commit)              │
│                                                                        │
│  [BOUNDARY PROTECTION]: PatchPilot source repository is 100% UNTOUCHED │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Pinned Package Coordinates & Compatibility

| Component | Pinned Version | Role & Notes |
| :--- | :--- | :--- |
| `@truefoundry/trueforge-sdk` | `0.185.0` | Pinned client library for session, turn streaming, and cancellation. |
| `@truefoundry/trueforge` | `0.185.1` | Standalone server daemon running out-of-process on port 8790. |
| `@truefoundry/trueforge-core` | `0.185.1` | Agent runtime harness managing tool execution, ssrfGuard, and remote MCP clients. |
| `@modelcontextprotocol/sdk` | `1.32.2` | Official MCP TypeScript SDK providing `StreamableHTTPServerTransport` and `Server`. |
| `zod` | `3.25.76` | Schema validation and input typing for tools and MCP requests. |

---

## 3. Network Security & SSRF Allowlist Configuration

### The Localhost SSRF Guard
TrueForge v0.185.1 includes an outbound network policy (`ssrfGuard.ts`) that strictly blocks connections to loopback (`127.0.0.0/8`, `::1`), private CIDRs (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local metadata (`169.254.0.0/16`), and internal hostnames (`.localhost`, `.local`).

### Official Development Allowlist Solution
In Section 2, the prompt instructs:
> *"Investigate the documented TrueForge outbound URL allowlist and networking configuration. Use only an explicit, documented development configuration. Do not disable SSRF protection globally."*

Inspection of `@truefoundry/trueforge` source revealed the authoritative configuration key:
`OUTBOUND_URL_ALLOWED_HOSTS: parseJsonStringArrayEnv({ envKey: "OUTBOUND_URL_ALLOWED_HOSTS", raw: getEnv("OUTBOUND_URL_ALLOWED_HOSTS") })`

By setting:
```bash
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1", "localhost"]'
```
1. `NETWORK_POLICY_ENABLED` remains `true` (SSRF guard is **not** disabled globally).
2. Attempts to reach metadata (`169.254.169.254`) or unapproved private hosts are still blocked with HTTP 400 (`Outbound URL blocked for host ...`).
3. TrueForge's internal `remoteMcpClient` is explicitly permitted to connect to the authenticated local loopback MCP endpoint `http://127.0.0.1:<port>/mcp`.

---

## 4. MCP Tools Implemented

| Tool Name | Input Schema | Security Controls | Description |
| :--- | :--- | :--- | :--- |
| `list_workspace_files` | `{ directory?: string }` | Path confinement, `.git` filtering | Lists files/directories inside the isolated fixture root. |
| `read_workspace_file` | `{ path: string }` | Extension allowlist, 1MB size limit | Reads file content and returns SHA-256 hash. |
| `write_workspace_file` | `{ path: string, content: string }` | Extension allowlist, traversal check, 1MB limit | Writes replacement content inside the fixture. |
| `run_workspace_tests` | `{ testFile?: string }` | No shell execution (`shell: false`), 5s timeout, 64KB max buffer | Runs `node --test tests/calculator.test.mjs` with deterministic output. |
| `get_workspace_status` | `{}` | Scoped to fixture `.git` root | Returns git porcelain status and list of modified/untracked files. |

---

## 5. Security & Isolation Invariants

1. **Loopback Binding Only:** Server throws `SecurityError` if asked to bind to any non-loopback interface (`0.0.0.0` or external IP).
2. **Mandatory Bearer Authentication:** All HTTP requests without a valid `Authorization: Bearer <token>` header receive immediate HTTP 401 Unauthorized.
3. **Strict Path Confinement:** Every file operation is validated through `resolveSafeWorkspacePath()`. Any `../` traversal, drive-letter escape, null byte sequence, or symlink pointing outside the fixture root is rejected.
4. **Extension Allowlist:** Only approved development extensions (`.ts`, `.js`, `.json`, `.md`, `.txt`, `.yml`) are permitted. Executables (`.exe`, `.dll`, `.bat`, `.cmd`, `.sh`, `.ps1`) and secrets (`.env`, `.pem`, `.key`) are strictly blocked.
5. **Zero Host Mutation:** Verified empirically by taking recursive SHA-256 fingerprints of the host PatchPilot repository before and after test execution. 0 files were created, modified, or deleted in the host repository.

---

## 6. Test Suite & Verification Instructions

```bash
# 1. Install dependencies
cd spikes/mcp-workspace
npm install

# 2. Compile TypeScript
npm run build

# 3. Generate deterministic disposable fixture
npm run fixture:create

# 4. Run Security Test Suite (14 tests)
node --test dist/tests/security.test.js

# 5. Run Direct MCP Protocol Test Suite (9 tests)
node --test dist/tests/mcp-protocol.test.js

# 6. Run Workspace Isolation Proof (7 tests)
node --test dist/tests/isolation.test.js

# 7. Run Isolated Extension Adapter Test (6 tests)
node --test dist/tests/adapter.test.js

# 8. Run Cancellation Semantics Test (5 tests)
node --test dist/tests/cancellation.test.js

# 9. Run TrueForge Integration Test (4 tests)
node --test dist/tests/trueforge-integration.test.js
```

---

## 7. Known Limitations & Hosted Deployment Requirements

1. **Standalone Development vs. Hosted Cluster:**
   - In local development, loopback allowlisting (`OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'`) is optimal and secure.
   - In hosted multi-tenant TrueForge, agents cannot connect to developer `127.0.0.1` directly. A secure reverse tunnel with mTLS or containerized sandbox sidecar synchronization is required.
2. **Upstream Model Provider Key Required for Full Agent Autonomy:**
   - TrueForge connector discovery and tool registry work without an LLM key.
   - Turn execution requires valid provider credentials; without them, TrueForge terminates turns with `[Model Error] (401)`. Under Prompt 005 rules, end-to-end autonomous turns are marked `BLOCKED`.
