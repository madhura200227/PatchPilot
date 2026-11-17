# PatchPilot: TrueForge SDK & Runtime Feasibility Spike

This directory contains the executable feasibility spike validating the integration path between **PatchPilot** and the **TrueForge Agent Runtime**.

---

## 1. Verified Package & Versions

Through npm registry metadata inspection and local verification:

| Artifact | Verified Package Name | Version | Role in TrueForge Architecture |
| :--- | :--- | :--- | :--- |
| **Client SDK** | `@truefoundry/trueforge-sdk` | `0.185.0` | Official TypeScript client library providing typed HTTP & SSE bindings. |
| **Server Daemon** | `@truefoundry/trueforge` | `0.185.1` | Standalone or clustered agent server daemon and HTTP API (`bin: trueforge`). |
| **Core Engine** | `@truefoundry/trueforge-core` | `0.185.1` | Agent runtime harness library managing LLM execution, planning, and tools. |

*Inconsistency Note Resolved:* Official documentation mentions `@truefoundry/trueforge-core` in introduction sections and `@truefoundry/trueforge-sdk` in quickstart guides. Inspection confirms that `@truefoundry/trueforge-sdk` is the client library for consumers, while `@truefoundry/trueforge-core` is the internal engine used by the server daemon.

---

## 2. Required Runtime Versions & Compatibility Analysis

- **System Node Tested:** `v24.12.0` (npm `11.6.2`) on Windows x64.
- **TrueForge Server Engine Requirement:** `node: '>=22.14.0'`.
- **TrueForge SDK Engine Requirement:** `node: '>=22.0.0'`.
- **VS Code Extension Host Environment:** Visual Studio Code (v1.90+) bundles Electron with **Node.js v20.x**.

### Critical Compatibility Limitation & Architectural Decision:
The TrueForge server **cannot** run in-process within the VS Code Extension Host due to the `node >= 22.14.0` engine requirement. Therefore, the TrueForge runtime must run as an **out-of-process daemon** (local process on Node 22+ or containerized in Docker) listening on `http://localhost:8790`. The VS Code extension interacts with TrueForge strictly over HTTP/SSE.

---

## 3. Installation & Spike Execution

```bash
# 1. Navigate to the spike directory
cd spikes/trueforge-runtime

# 2. Install pinned dependencies
npm install

# 3. Compile TypeScript sources (Strict Mode)
npm run build

# 4. Run Runtime Diagnostics
node dist/runtime-info.js

# 5. Run Client Connection Test
node dist/client.js

# 6. Run Session Lifecycle Test
node dist/session-test.js

# 7. Run Event Streaming Verification
node dist/streaming-test.js

# 8. Run Cancellation Verification (Layers A, B, C)
node dist/cancellation-test.js
```

---

## 4. Client Connection Architecture

PatchPilot instantiates the official `TrueForge` client:

```typescript
import { TrueForge } from "@truefoundry/trueforge-sdk";

const client = new TrueForge({
  baseUrl: process.env.TRUEFORGE_SERVER_URL || "http://localhost:8790",
  timeoutInSeconds: 30,
  maxRetries: 2,
  auth: process.env.TRUEFORGE_API_KEY ? { token: process.env.TRUEFORGE_API_KEY } : false,
});
```

- When running against local standalone TrueForge without authentication, passing `auth: false` bypasses bearer token requirements.
- Standard requests use HTTP REST under `/api/v1/*`.
- Streaming turn requests return typed `core.Stream<TrueForge.TurnStreamingEvent>`.

---

## 5. Session Creation Behaviour

- Sessions are created via `client.sessions.create({ agent: ... })`.
- Supported agent modes:
  1. **Inline Agent Spec:** `{ spec: { model: { name: "provider/model" }, instructions: "..." } }`.
  2. **Named Agent Reference:** `{ name: "agent_name" }`.
- Session creation returns an authoritative, monotonic ULID (e.g. `01m7mmk5kke7364b1fxsvjq7b3`).
- Full lifecycle CRUD (`create`, `get`, `list`, `update`, `delete`) was verified empirically with 100% pass rate.

---

## 6. Streaming Event Behaviour

- Streaming is initiated via `client.sessions.createTurnStream(sessionId, { input: [...] })`.
- Consumed via standard `for await (const event of stream)`.
- Key typed events classified during live testing:
  - `turn.created` (carries monotonic `turnId`).
  - `model.message` (carries active thread and model metadata).
  - `turn.done` (carries terminal turn state: `state.status: "done" | "cancelled" | "error"`, timestamps, and token telemetry).
- Authoritative state must be verified through `client.sessions.getTurn(sessionId, turnId)`. A closed SSE stream does not guarantee completed execution.

---

## 7. MCP & Sandbox Architecture

TrueForge isolates tool and sandbox execution from the client:
- **Supported MCP Transports:** `"streamable-http"` and `"sse"`. Stdio is not a direct transport for TrueForge remote MCP connectors.
- **SSRF Protection:** The TrueForge server enforces outbound URL validation and blocks connections to `localhost` by default.
- **Sandbox Provider:** When configured with Daytona or Docker, TrueForge runs tools in an isolated sandbox. Artifacts created by the assistant can be downloaded via `client.sessions.downloadSandboxFile()`.

---

## 8. Workspace Access Strategy for PatchPilot

To safely connect TrueForge with the developer's local VS Code workspace:

1. **Approach 1 (Recommended for Local Dev):** Run a lightweight local HTTP/SSE MCP server bridge on a non-blocked interface or configured host, exposing controlled file operations (read file, list dir, run pytest) bound strictly to the `.patchpilot/worktrees/` directory.
2. **Approach 2 (Sandbox Sync):** When TrueForge runs in a Docker or Daytona container, stage repository files into the sandbox via Git clone or tarball sync, execute the agent turn inside the container, and retrieve modified diffs via `client.sessions.downloadSandboxFile()` or Git worktree diffs for hunk review.

---

## 9. Cancellation Findings

Cancellation operates across three distinct operational layers:

- **Layer A (Client Stream Cancellation):** **VERIFIED (PASS)**. Passing an `AbortSignal` to `createTurnStream(..., { abortSignal })` cleanly terminates the client-side SSE connection with an `AbortError`.
- **Layer B (Server-Side Turn Cancellation):** **VERIFIED (PASS)**. Calling `client.sessions.cancel(sessionId)` dispatches `POST /api/v1/sessions/:id/cancel`. TrueForge halts the model loop and transitions the turn state to `cancelled` with reason `client-cancelled`.
- **Layer C (Sandbox Execution Cancellation):** **NOT VERIFIED**. Terminating active sandbox processes (e.g. infinite loops in test runners) requires container lifecycle intervention by TrueForge server. Standalone local mode without Docker/Daytona daemon cannot empirically verify sandbox process termination.

---

## 10. Reconnection & Recovery Findings

- If an SSE connection drops mid-turn, the client must **not** resubmit the user prompt.
- The client queries `client.sessions.getTurn(sessionId, turnId)` to determine the authoritative turn status.
- If the turn is still `"running"`, the client resumes live observation via `client.sessions.subscribeToTurn(sessionId, turnId, { from_event_id })`.

---

## 11. Known Limitations & Blockers

1. **Model Provider Required for Turn Execution:** TrueForge requires at least one model provider configured in settings (`/api/v1/settings/model-providers`). Without valid API keys, turns cleanly fail with `[Model Error] (401)`.
2. **SSRF Guardrails:** Local MCP servers cannot use `http://localhost:<port>` without host whitelisting in TrueForge server configuration.
3. **Node Engine Discrepancy:** VS Code extension host (Node 20) vs. TrueForge server (Node 22.14+).

---

## 12. Final Technical Recommendation

1. **Sole Loop Rule Upheld:** The integration feasibility spike conclusively proves that TrueForge owns the complete model reasoning, planning, and execution loop. PatchPilot interacts purely as an editor presentation surface and evidence auditor.
2. **Architecture Decisions to Close:**
   - Close **OD-10**: Verified exact package is `@truefoundry/trueforge-sdk@0.185.0`.
   - Close **OD-05**: MCP transport is HTTP/SSE (`streamable-http` or `sse`), not stdio.
3. **Milestone 0 Readiness:** PatchPilot is **cleared to proceed to Milestone 0 (Extension Skeleton & TrueForge Client Bridge)**.
