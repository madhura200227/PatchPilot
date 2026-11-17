import * as http from "node:http";
import * as path from "node:path";
import * as fs from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerWorkspaceTools } from "./tools/index.js";

export interface WorkspaceMcpServerConfig {
  host?: string;
  port?: number;
  authToken: string;
  workspaceRoot: string;
  maxBodySizeBytes?: number;
  serverName?: string;
  serverVersion?: string;
}

export interface RunningMcpServer {
  host: string;
  port: number;
  url: string;
  workspaceRoot: string;
  authToken: string;
  server: http.Server;
  stop: () => Promise<void>;
  mcpServer: Server;
  transport: StreamableHTTPServerTransport;
}

export const DEFAULT_MAX_BODY_SIZE_BYTES = 1024 * 1024; // 1MB limit for tool invocations and writes

export function validateHostBinding(host: string): void {
  const normalized = host.toLowerCase().trim();
  if (normalized !== "127.0.0.1" && normalized !== "localhost" && normalized !== "::1") {
    throw new Error(
      `Security Violation: MCP workspace server is strictly restricted to loopback interface. Refusing to bind to "${host}".`
    );
  }
}

export function validateWorkspaceRoot(workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Workspace root does not exist: "${resolved}"`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Workspace root must be a directory: "${resolved}"`);
  }
  return resolved;
}

export async function createWorkspaceMcpServer(config: WorkspaceMcpServerConfig): Promise<RunningMcpServer> {
  const host = config.host || "127.0.0.1";
  validateHostBinding(host);

  const workspaceRoot = validateWorkspaceRoot(config.workspaceRoot);
  const maxBodySize = config.maxBodySizeBytes || DEFAULT_MAX_BODY_SIZE_BYTES;

  if (!config.authToken || config.authToken.trim().length < 8) {
    throw new Error("Security Violation: MCP workspace server requires an authentication token of at least 8 characters.");
  }
  const expectedAuthToken = config.authToken.trim();

  // Create core MCP Server instance with required capabilities
  const mcpServer = new Server(
    {
      name: config.serverName || "patchpilot-workspace-mcp",
      version: config.serverVersion || "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register deterministic workspace tools bound strictly to workspaceRoot
  registerWorkspaceTools(mcpServer, workspaceRoot);

  // Initialize Streamable HTTP Transport
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });

  await mcpServer.connect(transport);

  // Create HTTP server with authentication and size limit guards
  const server = http.createServer(async (req, res) => {
    // 1. Health check endpoint (for VS Code adapter and diagnostic probes)
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "healthy",
          server: "patchpilot-workspace-mcp",
          boundHost: host,
          workspaceRoot,
          timestamp: new Date().toISOString(),
        })
      );
      return;
    }

    // 2. Authentication check: Validate Authorization header
    const authHeader = req.headers["authorization"];
    const tokenHeader = req.headers["x-patchpilot-token"];

    let tokenProvided: string | null = null;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      tokenProvided = authHeader.slice(7).trim();
    } else if (typeof tokenHeader === "string") {
      tokenProvided = tokenHeader.trim();
    }

    if (!tokenProvided || tokenProvided !== expectedAuthToken) {
      res.writeHead(401, {
        "Content-Type": "application/json",
        "WWW-Authenticate": 'Bearer realm="PatchPilot Workspace MCP"',
      });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Unauthorized: Invalid or missing authentication token for PatchPilot Workspace MCP",
          },
          id: null,
        })
      );
      return;
    }

    // 3. Request body size check & dispatch to Streamable HTTP Transport
    if (req.method === "POST") {
      let bodyLength = 0;
      let exceeded = false;
      const chunks: Buffer[] = [];

      req.on("data", (chunk: Buffer) => {
        bodyLength += chunk.length;
        if (bodyLength > maxBodySize) {
          exceeded = true;
          req.destroy(new Error("Payload Too Large"));
        } else {
          chunks.push(chunk);
        }
      });

      req.on("end", async () => {
        if (exceeded) {
          if (!res.headersSent) {
            res.writeHead(413, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                error: {
                  code: -32600,
                  message: `Payload Too Large: Request body exceeded ${maxBodySize} bytes limit`,
                },
                id: null,
              })
            );
          }
          return;
        }

        try {
          // Pass request through streamable HTTP transport
          await transport.handleRequest(req, res);
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                error: { code: -32603, message: `Internal server error: ${errMsg}` },
                id: null,
              })
            );
          }
        }
      });

      req.on("error", (err) => {
        if (!res.headersSent) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // 4. Handle GET for SSE initialization / handshake
    if (req.method === "GET") {
      try {
        await transport.handleRequest(req, res);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: errMsg }));
        }
      }
      return;
    }

    // Other methods
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method Not Allowed" }));
  });

  return new Promise<RunningMcpServer>((resolve, reject) => {
    server.on("error", reject);
    server.listen(config.port || 0, host, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Unable to obtain server listening address"));
        return;
      }
      const boundPort = addr.port;
      const url = `http://${host}:${boundPort}/mcp`;

      const running: RunningMcpServer = {
        host,
        port: boundPort,
        url,
        workspaceRoot,
        authToken: expectedAuthToken,
        server,
        mcpServer,
        transport,
        stop: async () => {
          await transport.close();
          await mcpServer.close();
          await new Promise<void>((res) => server.close(() => res()));
        },
      };

      resolve(running);
    });
  });
}
