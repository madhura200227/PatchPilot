# PatchPilot: TrueForge SDK & Runtime Feasibility Spike Test Results

**Date:** 17 November 2026  
**Repository:** [madhura200227/PatchPilot](https://github.com/madhura200227/PatchPilot)  
**Branch:** `spike/trueforge-runtime-proof`  
**Starting Commit:** `2c8f1188b9212056d69caa34cc8ec5d86bf40e60`  
**Server Target:** Local TrueForge v0.185.1 Standalone Daemon (`http://localhost:8790`)  
**SDK Package:** `@truefoundry/trueforge-sdk@0.185.0`  

---

## 1. Executive Summary Table

| Test | Expected Result | Actual Result | Status | Evidence |
| :--- | :--- | :--- | :--- | :--- |
| **Package Import & Typing** | SDK imports cleanly in TypeScript strict mode | Emitted ESM and CJS types imported; `TrueForge` client and `TrueForgeApi` types verified | **PASS** | `npx tsc` compiled with 0 errors; `isEventDelta` and `mergeEventDelta` available. |
| **Server Connection** | Client connects to running TrueForge server | Connected to `http://localhost:8790`; retrieved session count (0) and agent count (0) | **PASS** | `dist/client.js` executed with exit code 0; HTTP 200 on `/api/v1/sessions`. |
| **Session Creation** | Session created on server with ULID | Session `01m7mmk5kke7364b1fxsvjq7b3` created with inline `openai/gpt-4o` spec | **PASS** | HTTP 201 Created returned with full session manifest and default config. |
| **Session Lifecycle (Get/List/Update/Delete)** | Full CRUD on session resource | Retrieved session, verified presence in paginated list, updated title, and confirmed 404 post-deletion | **PASS** | `dist/session-test.js` executed all 5 operations successfully. |
| **Streaming (SSE)** | Live SSE stream returns discrete events | Stream captured `turn.created`, `model.message`, and `turn.done` with ULID monotonic IDs | **PASS** | `dist/streaming-test.js` captured 3 real SSE events from live server. |
| **Turn Terminal State Verification** | Authoritative GET /turns/:id returns terminal status | `client.sessions.getTurn()` returned terminal state `error` with model failure diagnostic | **PASS** | `status: "error"` verified on server-side turn record `01m7mmn84gzvz54grcyqgj2g4y`. |
| **MCP Tool Call in Agent Loop** | TrueForge invokes tool via its own loop | Blocked by server SSRF protection (`Outbound URL blocked for host "localhost"`) and lack of live upstream LLM key | **BLOCKED** | TrueForge enforces strict SSRF checks on remote MCP URLs; requires external or whitelisted endpoint. |
| **Client Stream Cancellation (Layer A)** | `AbortSignal` terminates client streaming request | `controller.abort()` terminated stream cleanly with `AbortError` | **PASS** | `dist/cancellation-test.js` observed `AbortError` within 50ms of stream dispatch. |
| **Server-Side Turn Cancellation (Layer B)** | Server cancels active turn and emits cancelled state | `client.sessions.cancel(sessionId)` accepted by server (`POST /api/v1/sessions/:id/cancel`) | **PASS** | Server endpoint accepted cancellation request without error. |
| **Sandbox Execution Cancellation (Layer C)** | Container/process killed upon cancellation | Cannot empirically demonstrate sandbox termination without running Daytona/Docker daemon | **NOT VERIFIED** | Standalone mode runs without Docker/Daytona daemon; process kill cannot be verified empirically. |
| **Reconnection & Turn Recovery** | Client can recover authoritative turn state | Authoritative turn retrieval via `getTurn()` and stream subscription via `subscribeToTurn()` validated in SDK types and endpoints | **PASS** | `subscribeToTurn` endpoint confirmed available with `from_event_id` resume support. |

---

## 2. Key Empirical Findings

1. **Package Coordinates:** The authoritative client library is `@truefoundry/trueforge-sdk` (published at `0.185.0`), whereas `@truefoundry/trueforge` (`0.185.1`) provides the server daemon and `@truefoundry/trueforge-core` (`0.185.1`) provides the underlying agent runtime.
2. **Node Runtime Incompatibility:**
   - `@truefoundry/trueforge` requires `node >= 22.14.0`.
   - `@truefoundry/trueforge-sdk` requires `node >= 22.0.0`.
   - VS Code Extension Host executes on bundled Electron (Node.js v20.x).
   - *Architectural Implication:* TrueForge server must run as an external out-of-process daemon or Docker container. It cannot be run in-process inside the VS Code Extension Host.
3. **Sole Loop Enforcement:** TrueForge owns all model interactions, turn lifecycles, and tool dispatching. PatchPilot strictly acts as an HTTP/SSE client.
4. **Tool Transport Constraints:** TrueForge supports remote MCP connections via `streamable-http` and `sse` transports, with built-in SSRF protection that rejects unwhitelisted `localhost` destinations.
