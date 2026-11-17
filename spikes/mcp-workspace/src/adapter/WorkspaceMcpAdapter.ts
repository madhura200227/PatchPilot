import * as crypto from "node:crypto";
import { createWorkspaceMcpServer, RunningMcpServer } from "../server.js";

export type McpAdapterState = "stopped" | "starting" | "running" | "error";

export interface McpAdapterStatus {
  state: McpAdapterState;
  host: string;
  port: number | null;
  url: string | null;
  workspaceRoot: string | null;
  authTokenRedacted: string | null;
  startedAt: string | null;
  uptimeSeconds: number;
}

export interface HealthCheckResult {
  healthy: boolean;
  statusCode: number;
  latencyMs: number;
  details?: Record<string, unknown>;
  error?: string;
}

export interface AdapterStartOptions {
  workspaceRoot: string;
  port?: number;
  host?: string;
  customToken?: string;
}

/**
 * Isolated Extension Adapter for PatchPilot Workspace MCP Server.
 *
 * Demonstrates how a future PatchPilot VS Code extension component safely orchestrates
 * the local MCP server lifecycle:
 * - Generates and isolates dynamic authentication secrets
 * - Enforces loopback binding (127.0.0.1)
 * - Probes server health
 * - Provides graceful teardown
 * - Never starts automatically on extension activation
 */
export class WorkspaceMcpAdapter {
  private runningServer: RunningMcpServer | null = null;
  private state: McpAdapterState = "stopped";
  private startedAt: Date | null = null;
  private currentToken: string | null = null;
  private currentWorkspaceRoot: string | null = null;

  public getState(): McpAdapterState {
    return this.state;
  }

  public getStatus(): McpAdapterStatus {
    const uptimeSeconds = this.startedAt ? Math.floor((Date.now() - this.startedAt.getTime()) / 1000) : 0;
    const tokenRedacted = this.currentToken
      ? `${this.currentToken.slice(0, 4)}...${this.currentToken.slice(-4)}`
      : null;

    return {
      state: this.state,
      host: this.runningServer?.host || "127.0.0.1",
      port: this.runningServer?.port || null,
      url: this.runningServer?.url || null,
      workspaceRoot: this.currentWorkspaceRoot,
      authTokenRedacted: tokenRedacted,
      startedAt: this.startedAt ? this.startedAt.toISOString() : null,
      uptimeSeconds,
    };
  }

  public getAuthToken(): string {
    if (!this.currentToken || this.state !== "running") {
      throw new Error("Cannot get authentication token: MCP adapter is not running");
    }
    return this.currentToken;
  }

  public getEndpointUrl(): string {
    if (!this.runningServer || this.state !== "running") {
      throw new Error("Cannot get endpoint URL: MCP adapter is not running");
    }
    return this.runningServer.url;
  }

  public async start(options: AdapterStartOptions): Promise<McpAdapterStatus> {
    if (this.state === "running") {
      throw new Error("MCP server adapter is already running. Call stop() before starting a new instance.");
    }

    this.state = "starting";
    try {
      // Generate cryptographically secure random authentication token
      this.currentToken = options.customToken || `sec-patchpilot-${crypto.randomBytes(24).toString("hex")}`;
      this.currentWorkspaceRoot = options.workspaceRoot;

      this.runningServer = await createWorkspaceMcpServer({
        host: options.host || "127.0.0.1",
        port: options.port || 0, // 0 selects a free ephemeral port
        authToken: this.currentToken,
        workspaceRoot: options.workspaceRoot,
        serverName: "patchpilot-extension-mcp-adapter",
      });

      this.startedAt = new Date();
      this.state = "running";
      return this.getStatus();
    } catch (err) {
      this.state = "error";
      this.currentToken = null;
      this.runningServer = null;
      throw err;
    }
  }

  public async checkHealth(): Promise<HealthCheckResult> {
    if (!this.runningServer || this.state !== "running") {
      return {
        healthy: false,
        statusCode: 0,
        latencyMs: 0,
        error: "Server is not running",
      };
    }

    const healthUrl = `http://${this.runningServer.host}:${this.runningServer.port}/health`;
    const start = Date.now();

    try {
      const response = await fetch(healthUrl, { method: "GET" });
      const latencyMs = Date.now() - start;

      if (response.ok) {
        const details = (await response.json()) as Record<string, unknown>;
        return {
          healthy: true,
          statusCode: response.status,
          latencyMs,
          details,
        };
      }

      return {
        healthy: false,
        statusCode: response.status,
        latencyMs,
        error: `HTTP ${response.status} ${response.statusText}`,
      };
    } catch (err: unknown) {
      const latencyMs = Date.now() - start;
      return {
        healthy: false,
        statusCode: 0,
        latencyMs,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  public async stop(): Promise<void> {
    if (this.runningServer) {
      await this.runningServer.stop();
      this.runningServer = null;
    }
    this.state = "stopped";
    this.startedAt = null;
    this.currentToken = null;
    this.currentWorkspaceRoot = null;
  }
}
