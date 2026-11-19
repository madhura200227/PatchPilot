import { ChildProcess, fork } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ILogger } from "../output/logger";
import { McpChildErrorMessage, McpChildInitMessage, McpChildReadyMessage } from "./mcpServerEntry";
import { InlineSelectionConstraint } from "./proposalStore";

/**
 * PatchPilot Out-of-Process MCP Server Lifecycle Supervisor
 *
 * - Spawns dist/mcpServer.js with ELECTRON_RUN_AS_NODE=1 so it runs safely inside VS Code Electron.
 * - Generates a fresh per-process cryptographic Bearer token and transmits it via IPC (never CLI args).
 * - Awaits explicit readiness handshake and verifies /health before resolving start().
 * - Detects unexpected crashes and supports bounded safe restarts.
 * - Stops ONLY its own managed child process on stop()/deactivation.
 */

export type ProcessLifecycleState = "stopped" | "starting" | "running" | "crashed" | "error";

export interface ManagedMcpProcessStatus {
  state: ProcessLifecycleState;
  pid: number | null;
  host: string;
  port: number | null;
  url: string | null;
  controlBaseUrl: string | null;
  workspaceRoot: string | null;
  proposalStoreDir: string | null;
  startedAt: string | null;
  restartCount: number;
  lastError?: string;
}

export interface StartProcessOptions {
  workspaceRoot: string;
  proposalStoreDir: string;
  serverScriptPath: string;
  tokenBudget?: number;
  port?: number;
  readinessTimeoutMs?: number;
}

export class WorkspaceProcessManager {
  private child: ChildProcess | null = null;
  private state: ProcessLifecycleState = "stopped";
  private authToken: string | null = null;
  private host = "127.0.0.1";
  private port: number | null = null;
  private url: string | null = null;
  private controlBaseUrl: string | null = null;
  private workspaceRoot: string | null = null;
  private proposalStoreDir: string | null = null;
  private startedAt: string | null = null;
  private lastError: string | undefined;
  private restartCount = 0;
  private stoppingIntentionally = false;
  private lastStartOptions: StartProcessOptions | null = null;
  private readonly maxAutoRestarts = 2;
  private readonly crashListeners: Array<(reason: string) => void> = [];

  constructor(private readonly logger: ILogger) {}

  public onCrash(listener: (reason: string) => void): () => void {
    this.crashListeners.push(listener);
    return () => {
      const idx = this.crashListeners.indexOf(listener);
      if (idx >= 0) {
        this.crashListeners.splice(idx, 1);
      }
    };
  }

  public getStatus(): ManagedMcpProcessStatus {
    return {
      state: this.state,
      pid: this.child?.pid ?? null,
      host: this.host,
      port: this.port,
      url: this.url,
      controlBaseUrl: this.controlBaseUrl,
      workspaceRoot: this.workspaceRoot,
      proposalStoreDir: this.proposalStoreDir,
      startedAt: this.startedAt,
      restartCount: this.restartCount,
      lastError: this.lastError,
    };
  }

  public getAuthToken(): string {
    if (!this.authToken || this.state !== "running") {
      throw new Error("PatchPilot MCP server is not running.");
    }
    return this.authToken;
  }

  public getEndpointUrl(): string {
    if (!this.url || this.state !== "running") {
      throw new Error("PatchPilot MCP server is not running.");
    }
    return this.url;
  }

  public async start(options: StartProcessOptions): Promise<ManagedMcpProcessStatus> {
    if (this.state === "running" && this.child && this.workspaceRoot === options.workspaceRoot) {
      return this.getStatus();
    }

    if (this.child) {
      await this.stop();
    }

    if (!fs.existsSync(options.serverScriptPath)) {
      this.state = "error";
      this.lastError = `MCP server bundle missing at "${options.serverScriptPath}". Run "npm run compile".`;
      throw new Error(this.lastError);
    }

    this.stoppingIntentionally = false;
    this.state = "starting";
    this.lastError = undefined;
    this.lastStartOptions = { ...options };
    this.authToken = `sec-patchpilot-${crypto.randomBytes(24).toString("hex")}`;
    this.workspaceRoot = options.workspaceRoot;
    this.proposalStoreDir = options.proposalStoreDir;

    const readinessTimeoutMs = options.readinessTimeoutMs ?? 10_000;

    return new Promise<ManagedMcpProcessStatus>((resolve, reject) => {
      let settled = false;

      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
      };

      const child = fork(options.serverScriptPath, [], {
        cwd: path.dirname(options.serverScriptPath),
        env: childEnv,
        silent: true,
        execArgv: [],
      });

      this.child = child;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.state = "error";
          this.lastError = `MCP server readiness handshake timed out after ${readinessTimeoutMs}ms.`;
          child.kill("SIGTERM");
          reject(new Error(this.lastError));
        }
      }, readinessTimeoutMs);

      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8").trim();
        if (text) {
          this.logger.warn(`[MCP Child stderr] ${text}`);
        }
      });

      child.on("message", async (raw: unknown) => {
        const msg = raw as Partial<McpChildReadyMessage | McpChildErrorMessage> | undefined;
        if (!msg || typeof msg !== "object") {
          return;
        }

        if (msg.type === "ready" && !settled) {
          settled = true;
          clearTimeout(timeout);
          const ready = msg as McpChildReadyMessage;
          this.host = ready.host;
          this.port = ready.port;
          this.url = ready.url;
          this.controlBaseUrl = ready.controlBaseUrl;
          this.startedAt = new Date().toISOString();
          this.state = "running";

          // Verify HTTP /health probe
          const healthy = await this.checkHealth();
          if (!healthy.healthy) {
            this.state = "error";
            this.lastError = `MCP server reported ready but /health probe failed: ${healthy.error}`;
            await this.stop();
            reject(new Error(this.lastError));
            return;
          }

          this.logger.info(
            `PatchPilot Workspace MCP server ready on ${this.url} (PID ${ready.pid}, workspace: ${path.basename(ready.workspaceRoot)}).`
          );
          resolve(this.getStatus());
        } else if (msg.type === "error" && !settled) {
          settled = true;
          clearTimeout(timeout);
          this.state = "error";
          this.lastError = (msg as McpChildErrorMessage).message;
          reject(new Error(`MCP server startup failed: ${this.lastError}`));
        }
      });

      child.on("exit", (code, signal) => {
        clearTimeout(timeout);
        const wasRunning = this.state === "running";
        this.child = null;
        this.port = null;
        this.url = null;
        this.controlBaseUrl = null;

        if (!settled) {
          settled = true;
          this.state = "error";
          this.lastError = `MCP server exited prematurely during startup (code=${code}, signal=${signal}).`;
          reject(new Error(this.lastError));
          return;
        }

        if (!this.stoppingIntentionally && wasRunning) {
          this.state = "crashed";
          this.lastError = `MCP server crashed unexpectedly (code=${code}, signal=${signal}).`;
          this.logger.error(this.lastError);
          for (const listener of this.crashListeners) {
            try {
              listener(this.lastError);
            } catch {
              // Ignore listener errors
            }
          }
        } else {
          this.state = "stopped";
        }
      });

      child.on("error", (err) => {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          this.state = "error";
          this.lastError = err.message;
          reject(err);
        }
      });

      // Deliver init config including secret token over IPC (never CLI args)
      const initMsg: McpChildInitMessage = {
        type: "init",
        workspaceRoot: options.workspaceRoot,
        authToken: this.authToken!,
        proposalStoreDir: options.proposalStoreDir,
        port: options.port ?? 0,
        host: "127.0.0.1",
        tokenBudget: options.tokenBudget,
      };
      child.send(initMsg);
    });
  }

  public async restartIfEligible(): Promise<ManagedMcpProcessStatus | null> {
    if (!this.lastStartOptions || this.restartCount >= this.maxAutoRestarts) {
      return null;
    }
    this.restartCount++;
    this.logger.warn(
      `Attempting safe restart of PatchPilot Workspace MCP server (attempt ${this.restartCount}/${this.maxAutoRestarts})...`
    );
    return this.start(this.lastStartOptions);
  }

  public async checkHealth(): Promise<{ healthy: boolean; statusCode: number; error?: string }> {
    if (!this.controlBaseUrl) {
      return { healthy: false, statusCode: 0, error: "MCP server is not running." };
    }
    try {
      const resp = await fetch(`${this.controlBaseUrl}/health`, { method: "GET" });
      if (resp.ok) {
        return { healthy: true, statusCode: resp.status };
      }
      return { healthy: false, statusCode: resp.status, error: `HTTP ${resp.status}` };
    } catch (err: unknown) {
      return {
        healthy: false,
        statusCode: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  public async setActiveRun(
    runId: string | null,
    selectionConstraint?: InlineSelectionConstraint | null
  ): Promise<void> {
    if (!this.controlBaseUrl || !this.authToken || this.state !== "running") {
      return;
    }
    await fetch(`${this.controlBaseUrl}/control/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.authToken}`,
      },
      body: JSON.stringify({ runId, selectionConstraint }),
    });
  }

  public async cancelActiveOperations(
    runId?: string
  ): Promise<{ abortedCommands: number; discardedProposals: number }> {
    if (!this.controlBaseUrl || !this.authToken || this.state !== "running") {
      return { abortedCommands: 0, discardedProposals: 0 };
    }
    try {
      const resp = await fetch(`${this.controlBaseUrl}/control/cancel`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.authToken}`,
        },
        body: JSON.stringify({ runId }),
      });
      if (resp.ok) {
        const data = (await resp.json()) as { abortedCommands?: number; discardedProposals?: number };
        return {
          abortedCommands: data.abortedCommands ?? 0,
          discardedProposals: data.discardedProposals ?? 0,
        };
      }
    } catch {
      // Server may have already stopped
    }
    return { abortedCommands: 0, discardedProposals: 0 };
  }

  public async stop(): Promise<void> {
    this.stoppingIntentionally = true;
    const child = this.child;
    this.child = null;

    if (child && !child.killed) {
      await new Promise<void>((resolve) => {
        const forceTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // Ignore
          }
          resolve();
        }, 2500);

        child.once("exit", () => {
          clearTimeout(forceTimer);
          resolve();
        });

        try {
          if (child.connected) {
            child.send({ type: "stop" });
          } else {
            child.kill("SIGTERM");
          }
        } catch {
          try {
            child.kill("SIGTERM");
          } catch {
            clearTimeout(forceTimer);
            resolve();
          }
        }
      });
    }

    this.state = "stopped";
    this.port = null;
    this.url = null;
    this.controlBaseUrl = null;
    this.authToken = null;
    this.startedAt = null;
  }
}
