import { createWorkspaceMcpServer, RunningWorkspaceMcpServer } from "./mcpServerCore";

/**
 * PatchPilot Out-of-Process MCP Server Entrypoint (bundled to dist/mcpServer.js)
 *
 * Receives configuration securely via Node IPC message (never via CLI args, preventing
 * token exposure in OS process listings) and emits an explicit JSON readiness handshake.
 */

export interface McpChildInitMessage {
  type: "init";
  workspaceRoot: string;
  authToken: string;
  proposalStoreDir: string;
  port?: number;
  host?: string;
  tokenBudget?: number;
}

export interface McpChildStopMessage {
  type: "stop";
}

export type McpParentToChildMessage = McpChildInitMessage | McpChildStopMessage;

export interface McpChildReadyMessage {
  type: "ready";
  host: string;
  port: number;
  url: string;
  controlBaseUrl: string;
  pid: number;
  workspaceRoot: string;
  proposalStoreDir: string;
}

export interface McpChildErrorMessage {
  type: "error";
  message: string;
}

let activeServer: RunningWorkspaceMcpServer | null = null;
let shuttingDown = false;

function sendToParent(msg: McpChildReadyMessage | McpChildErrorMessage): void {
  if (typeof process.send === "function") {
    process.send(msg);
  } else {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  }
}

async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  if (activeServer) {
    try {
      await activeServer.stop();
    } catch {
      // Best-effort cleanup
    }
    activeServer = null;
  }
  process.exit(exitCode);
}

process.on("message", async (raw: unknown) => {
  const msg = raw as Partial<McpParentToChildMessage> | undefined;
  if (!msg || typeof msg !== "object") {
    return;
  }

  if (msg.type === "stop") {
    await shutdown(0);
    return;
  }

  if (msg.type === "init") {
    if (activeServer) {
      sendToParent({
        type: "ready",
        host: activeServer.host,
        port: activeServer.port,
        url: activeServer.url,
        controlBaseUrl: activeServer.controlBaseUrl,
        pid: process.pid,
        workspaceRoot: activeServer.workspaceRoot,
        proposalStoreDir: activeServer.proposalStore.getStoreDir(),
      });
      return;
    }

    try {
      const init = msg as McpChildInitMessage;
      activeServer = await createWorkspaceMcpServer({
        host: init.host || "127.0.0.1",
        port: init.port ?? 0,
        authToken: init.authToken,
        workspaceRoot: init.workspaceRoot,
        proposalStoreDir: init.proposalStoreDir,
        tokenBudget: init.tokenBudget,
      });

      sendToParent({
        type: "ready",
        host: activeServer.host,
        port: activeServer.port,
        url: activeServer.url,
        controlBaseUrl: activeServer.controlBaseUrl,
        pid: process.pid,
        workspaceRoot: activeServer.workspaceRoot,
        proposalStoreDir: activeServer.proposalStore.getStoreDir(),
      });
    } catch (err: unknown) {
      sendToParent({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      await shutdown(1);
    }
  }
});

process.on("disconnect", () => {
  void shutdown(0);
});

process.on("SIGTERM", () => {
  void shutdown(0);
});

process.on("SIGINT", () => {
  void shutdown(0);
});
