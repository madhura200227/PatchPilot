import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { assembleWorkspaceContext, formatContextPlanSummary } from "../context/contextAssembler";
import { searchAndRankWorkspace } from "../context/relevanceRanker";
import { resolveWorkspaceSymbol } from "../context/symbolResolver";
import { DEFAULT_CONTEXT_TOKEN_BUDGET } from "../context/tokenBudget";
import { executeSafeWorkspaceCommand, validateCommandSpec } from "../security/commandPolicy";
import {
  PROTECTED_DIRECTORIES,
  resolveCanonicalWorkspaceRoot,
  resolveSafeWorkspacePath,
  safeReadWorkspaceTextFile,
  SecurityError,
} from "../security/pathGuard";
import { isSensitiveFilePath, sanitizeSecretText } from "../security/secretFilter";
import { runCommandInExecutionOverlay } from "./executionOverlay";
import { InlineSelectionConstraint, ProposalStore } from "./proposalStore";

/**
 * PatchPilot Production Workspace MCP Server
 *
 * Exposes all 8 workspace capabilities to the TrueForge Agent Runtime over authenticated,
 * loopback-only Streamable HTTP transport:
 *   1. get_workspace_status   (read-only)
 *   2. list_workspace_files   (read-only)
 *   3. search_workspace       (read-only)
 *   4. read_workspace_file    (read-only)
 *   5. read_workspace_symbol  (read-only)
 *   6. get_context_plan       (read-only)
 *   7. propose_edit           (write-like proposal; never mutates workspace on disk)
 *   8. run_workspace_command  (destructive-hinted; runs strictly in disposable overlay)
 */

export const PATCHPILOT_MCP_TOOL_NAMES = [
  "get_workspace_status",
  "list_workspace_files",
  "search_workspace",
  "read_workspace_file",
  "read_workspace_symbol",
  "get_context_plan",
  "propose_edit",
  "run_workspace_command",
] as const;

export const PATCHPILOT_APPROVAL_REQUIRED_TOOLS = [
  "propose_edit",
  "run_workspace_command",
] as const;

export const PATCHPILOT_MCP_TOOLS = [
  {
    name: "get_workspace_status",
    description:
      "Inspect the workspace metadata, Git branch, modified/untracked files, and active PatchPilot proposal count.",
    annotations: {
      title: "Get Workspace Status",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "list_workspace_files",
    description:
      "List permitted source, test, and documentation files in a bounded workspace directory (excludes .git, secrets, and vendor directories).",
    annotations: {
      title: "List Workspace Files",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        directory: {
          type: "string",
          description: "Workspace-relative directory path (defaults to '.').",
        },
        recursive: {
          type: "boolean",
          description: "If true, list recursively up to maxEntries.",
        },
        maxEntries: {
          type: "number",
          description: "Maximum entries to return (default 100, max 300).",
        },
      },
    },
  },
  {
    name: "search_workspace",
    description:
      "Perform deterministic BM25 lexical search across permitted workspace files and return ranked file paths, relevance scores, and line-numbered snippets.",
    annotations: {
      title: "Search Workspace",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search keywords, identifiers, or natural-language query.",
        },
        pathPrefix: {
          type: "string",
          description: "Optional workspace-relative directory prefix to restrict search.",
        },
        maxResults: {
          type: "number",
          description: "Maximum ranked files to return (default 10, max 25).",
        },
        literalSubstring: {
          type: "boolean",
          description: "If true, match exact case-insensitive substring instead of BM25 tokens.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "read_workspace_file",
    description:
      "Read a permitted UTF-8 workspace file (optionally bounded by startLine/endLine) along with its SHA-256 content hash.",
    annotations: {
      title: "Read Workspace File",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative file path to read.",
        },
        startLine: {
          type: "number",
          description: "Optional 1-based start line.",
        },
        endLine: {
          type: "number",
          description: "Optional 1-based inclusive end line.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "read_workspace_symbol",
    description:
      "Resolve a function, class, method, interface, type, or documentation heading in the workspace and return its definition location and source snippet.",
    annotations: {
      title: "Read Workspace Symbol",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Symbol name or substring to resolve.",
        },
        filePath: {
          type: "string",
          description: "Optional workspace-relative file path to narrow lookup.",
        },
        maxResults: {
          type: "number",
          description: "Maximum symbol matches to return (default 8).",
        },
      },
      required: ["symbol"],
    },
  },
  {
    name: "get_context_plan",
    description:
      "Assemble and explain a deterministic, token-budgeted context plan for a task (including @file/@symbol mentions, automatic BM25 retrieval rationale, and remaining estimated budget).",
    annotations: {
      title: "Get Context Plan",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Task description or prompt (may include @file and @symbol references).",
        },
        tokenBudget: {
          type: "number",
          description: "Optional estimated token-equivalent budget (defaults to configured budget).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "propose_edit",
    description:
      "Submit a proposed file modification or new file into PatchPilot's isolated proposal store for human hunk-by-hunk review. Does NOT write directly to the user's workspace on disk.",
    annotations: {
      title: "Propose File Edit",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative file path to modify or create.",
        },
        content: {
          type: "string",
          description: "Complete proposed UTF-8 file content.",
        },
        summary: {
          type: "string",
          description: "Concise explanation of the proposed change.",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "run_workspace_command",
    description:
      "Run an allowlisted verification command (pytest, python -m pytest/unittest/flask, flask, node --test, npm test/lint/build, read-only git) inside a disposable workspace overlay containing active proposed edits.",
    annotations: {
      title: "Run Workspace Command (Disposable Overlay)",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        executable: {
          type: "string",
          description: "Bare allowlisted executable name (pytest, python, python3, flask, node, npm, git).",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Explicit argument array (no shell interpolation).",
        },
        timeoutMs: {
          type: "number",
          description: "Optional execution timeout in milliseconds (default 30000, max 120000).",
        },
      },
      required: ["executable", "args"],
    },
  },
];

export interface WorkspaceMcpServerConfig {
  host?: string;
  port?: number;
  authToken: string;
  workspaceRoot: string;
  proposalStoreDir?: string;
  tokenBudget?: number;
  maxBodySizeBytes?: number;
  serverName?: string;
  serverVersion?: string;
}

export interface ToolAuditEntry {
  timestamp: string;
  toolName: string;
  runId: string | null;
  durationMs: number;
  ok: boolean;
  summary: string;
}

export interface RunningWorkspaceMcpServer {
  host: string;
  port: number;
  url: string;
  controlBaseUrl: string;
  workspaceRoot: string;
  proposalStore: ProposalStore;
  authToken: string;
  server: http.Server;
  getAuditLog: () => ToolAuditEntry[];
  cancelActiveOperations: (runId?: string) => { abortedCommands: number; discardedProposals: number };
  stop: () => Promise<void>;
}

export const DEFAULT_MAX_BODY_SIZE_BYTES = 2 * 1024 * 1024; // 2 MiB for propose_edit JSON payloads

export function validateLoopbackHost(host: string): void {
  const normalized = host.toLowerCase().trim();
  if (normalized !== "127.0.0.1" && normalized !== "localhost" && normalized !== "::1") {
    throw new SecurityError(
      `Security Violation: PatchPilot MCP workspace server is strictly restricted to loopback. Refusing to bind to "${host}".`
    );
  }
}

function constantTimeTokenMatch(provided: string, expected: string): boolean {
  const bufA = Buffer.from(provided, "utf8");
  const bufB = Buffer.from(expected, "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function listFilesInWorkspace(
  workspaceRoot: string,
  relativeDir: string,
  recursive: boolean,
  maxEntries: number
): Array<{ name: string; relativePath: string; isDirectory: boolean; size: number }> {
  const safeDir = resolveSafeWorkspacePath(workspaceRoot, relativeDir, {
    checkExtension: false,
    mustExist: true,
    allowDirectory: true,
  });

  const stat = fs.statSync(safeDir);
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: "${relativeDir}"`);
  }

  const limit = Math.min(Math.max(maxEntries, 1), 300);
  const results: Array<{ name: string; relativePath: string; isDirectory: boolean; size: number }> = [];

  const scan = (dir: string): void => {
    if (results.length >= limit) {
      return;
    }
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (results.length >= limit) {
        return;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory() && PROTECTED_DIRECTORIES.has(entry.name.toLowerCase())) {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      const rel = path.relative(workspaceRoot, fullPath).replace(/\\/g, "/");
      if (isSensitiveFilePath(rel)) {
        continue;
      }

      let size = 0;
      try {
        size = fs.statSync(fullPath).size;
      } catch {
        continue;
      }

      results.push({
        name: entry.name,
        relativePath: rel,
        isDirectory: entry.isDirectory(),
        size,
      });

      if (recursive && entry.isDirectory()) {
        scan(fullPath);
      }
    }
  };

  scan(safeDir);
  return results;
}

async function getWorkspaceStatusPayload(
  workspaceRoot: string,
  proposalStore: ProposalStore,
  authToken: string
): Promise<Record<string, unknown>> {
  let branch = "unknown";
  let clean = true;
  let modifiedFiles: string[] = [];
  let untrackedFiles: string[] = [];
  let statusText = "NON_GIT_WORKSPACE";

  const hasGitDir = fs.existsSync(path.join(workspaceRoot, ".git"));
  if (hasGitDir) {
    const branchSpec = validateCommandSpec("git", ["rev-parse", "--abbrev-ref", "HEAD"], workspaceRoot);
    const branchRes = await executeSafeWorkspaceCommand(branchSpec, {
      cwd: workspaceRoot,
      timeoutMs: 4000,
      secretsToRedact: [authToken],
    });
    if (branchRes.passed && branchRes.stdout) {
      branch = branchRes.stdout;
    }

    const statusSpec = validateCommandSpec("git", ["status", "--porcelain"], workspaceRoot);
    const statusRes = await executeSafeWorkspaceCommand(statusSpec, {
      cwd: workspaceRoot,
      timeoutMs: 4000,
      secretsToRedact: [authToken],
    });
    if (statusRes.passed) {
      statusText = statusRes.stdout || "CLEAN";
      clean = statusRes.stdout.length === 0;
      if (statusRes.stdout) {
        for (const line of statusRes.stdout.split(/\r?\n/)) {
          if (!line) continue;
          const code = line.slice(0, 2);
          const filePath = line.slice(2).trim();
          if (code === "??") {
            untrackedFiles.push(filePath);
          } else {
            modifiedFiles.push(filePath);
          }
        }
      }
    }
  }

  const pendingProposals = proposalStore.listProposals();

  return {
    workspaceName: path.basename(workspaceRoot),
    gitRepository: hasGitDir,
    branch,
    clean,
    statusText,
    modifiedFiles,
    untrackedFiles,
    pendingProposalCount: pendingProposals.length,
    pendingProposalFiles: pendingProposals.map((p) => p.relativePath),
    activeRunId: proposalStore.getActiveRunId(),
  };
}

/**
 * Starts the authenticated loopback Workspace MCP Server with per-session Streamable HTTP transports.
 */
export async function createWorkspaceMcpServer(
  config: WorkspaceMcpServerConfig
): Promise<RunningWorkspaceMcpServer> {
  const host = config.host || "127.0.0.1";
  validateLoopbackHost(host);

  const workspaceRoot = resolveCanonicalWorkspaceRoot(config.workspaceRoot);
  const maxBodySize = config.maxBodySizeBytes ?? DEFAULT_MAX_BODY_SIZE_BYTES;
  const defaultTokenBudget = config.tokenBudget ?? DEFAULT_CONTEXT_TOKEN_BUDGET;

  if (!config.authToken || config.authToken.trim().length < 16) {
    throw new SecurityError(
      "Security Violation: MCP workspace server requires an authentication token of at least 16 characters."
    );
  }
  const expectedAuthToken = config.authToken.trim();
  const proposalStore = new ProposalStore(workspaceRoot, config.proposalStoreDir);

  const activeCommandControllers = new Set<AbortController>();
  const auditLog: ToolAuditEntry[] = [];
  const sessions = new Map<string, { mcpServer: Server; transport: StreamableHTTPServerTransport }>();

  const recordAudit = (entry: ToolAuditEntry): void => {
    auditLog.push(entry);
    if (auditLog.length > 200) {
      auditLog.shift();
    }
  };

  const cancelActiveOperations = (
    runId?: string
  ): { abortedCommands: number; discardedProposals: number } => {
    let abortedCommands = 0;
    for (const ctrl of activeCommandControllers) {
      if (!ctrl.signal.aborted) {
        ctrl.abort();
        abortedCommands++;
      }
    }
    activeCommandControllers.clear();

    const targetRun = runId ?? proposalStore.getActiveRunId();
    const discardedProposals = targetRun ? proposalStore.markRunCancelled(targetRun) : 0;
    return { abortedCommands, discardedProposals };
  };

  const buildMcpServerInstance = (): Server => {
    const mcpServer = new Server(
      {
        name: config.serverName || "patchpilot-workspace",
        version: config.serverVersion || "0.2.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
      return { tools: PATCHPILOT_MCP_TOOLS };
    });

    mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: rawArgs } = request.params;
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      const startTime = Date.now();
      const activeRunId = proposalStore.getActiveRunId();

      try {
        let payload: unknown;

        switch (name) {
          case "get_workspace_status": {
            payload = await getWorkspaceStatusPayload(workspaceRoot, proposalStore, expectedAuthToken);
            break;
          }

          case "list_workspace_files": {
            const directory = typeof args.directory === "string" && args.directory.trim() ? args.directory : ".";
            const recursive = args.recursive === true;
            const maxEntries = typeof args.maxEntries === "number" ? args.maxEntries : 100;
            const entries = listFilesInWorkspace(workspaceRoot, directory, recursive, maxEntries);
            payload = { directory, count: entries.length, entries };
            break;
          }

          case "search_workspace": {
            if (typeof args.query !== "string" || !args.query.trim()) {
              throw new Error("Missing required string argument 'query'.");
            }
            const results = searchAndRankWorkspace(workspaceRoot, args.query, {
              pathPrefix: typeof args.pathPrefix === "string" ? args.pathPrefix : undefined,
              maxResults: typeof args.maxResults === "number" ? args.maxResults : 10,
              literalSubstring: args.literalSubstring === true,
            });
            payload = { query: args.query, matchCount: results.length, results };
            break;
          }

          case "read_workspace_file": {
            if (typeof args.path !== "string" || !args.path.trim()) {
              throw new Error("Missing required string argument 'path'.");
            }
            const file = await safeReadWorkspaceTextFile(workspaceRoot, args.path);
            let content = file.content;
            const allLines = file.content.split(/\r?\n/);
            const totalLines = allLines.length;
            let startLine = 1;
            let endLine = totalLines;

            if (typeof args.startLine === "number" || typeof args.endLine === "number") {
              startLine = Math.max(1, Math.floor(typeof args.startLine === "number" ? args.startLine : 1));
              endLine = Math.min(
                totalLines,
                Math.max(startLine, Math.floor(typeof args.endLine === "number" ? args.endLine : totalLines))
              );
              content = allLines
                .slice(startLine - 1, endLine)
                .map((l, idx) => `${startLine + idx}: ${l}`)
                .join("\n");
            }

            payload = {
              path: file.relativePath,
              sha256: file.sha256,
              size: file.size,
              totalLines,
              startLine,
              endLine,
              content,
            };
            break;
          }

          case "read_workspace_symbol": {
            if (typeof args.symbol !== "string" || !args.symbol.trim()) {
              throw new Error("Missing required string argument 'symbol'.");
            }
            const matches = await resolveWorkspaceSymbol(workspaceRoot, args.symbol, {
              filePath: typeof args.filePath === "string" ? args.filePath : undefined,
              maxResults: typeof args.maxResults === "number" ? args.maxResults : 8,
            });
            payload = { symbol: args.symbol, matchCount: matches.length, matches };
            break;
          }

          case "get_context_plan": {
            if (typeof args.query !== "string" || !args.query.trim()) {
              throw new Error("Missing required string argument 'query'.");
            }
            const budget = typeof args.tokenBudget === "number" ? args.tokenBudget : defaultTokenBudget;
            const plan = await assembleWorkspaceContext(workspaceRoot, args.query, {
              tokenBudget: budget,
            });
            payload = {
              summary: formatContextPlanSummary(plan),
              plan,
            };
            break;
          }

          case "propose_edit": {
            if (typeof args.path !== "string" || !args.path.trim()) {
              throw new Error("Missing required string argument 'path'.");
            }
            if (typeof args.content !== "string") {
              throw new Error("Missing required string argument 'content'.");
            }
            const created = await proposalStore.createOrUpdateProposal({
              relativePath: args.path,
              proposedContent: args.content,
              summary: typeof args.summary === "string" ? args.summary : undefined,
            });
            payload = {
              proposalId: created.proposal.proposalId,
              relativePath: created.proposal.relativePath,
              isNewFile: created.proposal.isNewFile,
              originalSha256: created.proposal.originalSha256,
              proposedSha256: created.proposal.proposedSha256,
              hunkCount: created.proposal.hunks.length,
              addedLines: created.addedLines,
              removedLines: created.removedLines,
              selectionExpansion: created.proposal.selectionExpansion,
              note: "Proposal recorded in isolated PatchPilot proposal storage. Workspace on disk was NOT modified; human review and approval are required to apply.",
              unifiedDiff: created.unifiedDiff,
            };
            break;
          }

          case "run_workspace_command": {
            if (typeof args.executable !== "string" || !args.executable.trim()) {
              throw new Error("Missing required string argument 'executable'.");
            }
            if (!Array.isArray(args.args) || !args.args.every((a) => typeof a === "string")) {
              throw new Error("Argument 'args' must be an array of strings.");
            }
            if (activeRunId && proposalStore.isRunCancelled(activeRunId)) {
              throw new SecurityError(
                `Active run "${activeRunId}" was cancelled; refusing to start command execution.`
              );
            }

            const validatedSpec = validateCommandSpec(args.executable, args.args as string[], workspaceRoot, {
              requireTestTargetExist: false,
            });

            const cmdController = new AbortController();
            activeCommandControllers.add(cmdController);
            try {
              const report = await runCommandInExecutionOverlay(
                workspaceRoot,
                proposalStore.listProposals(),
                validatedSpec,
                {
                  timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
                  signal: cmdController.signal,
                  secretsToRedact: [expectedAuthToken],
                }
              );
              payload = report;
            } finally {
              activeCommandControllers.delete(cmdController);
            }
            break;
          }

          default: {
            recordAudit({
              timestamp: new Date().toISOString(),
              toolName: name,
              runId: activeRunId,
              durationMs: Date.now() - startTime,
              ok: false,
              summary: `Unknown tool "${name}"`,
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Unknown tool "${name}". Supported tools: ${PATCHPILOT_MCP_TOOL_NAMES.join(", ")}`,
                },
              ],
              isError: true,
            };
          }
        }

        recordAudit({
          timestamp: new Date().toISOString(),
          toolName: name,
          runId: activeRunId,
          durationMs: Date.now() - startTime,
          ok: true,
          summary: `Completed ${name}`,
        });

        return {
          content: [
            {
              type: "text",
              text: sanitizeSecretText(JSON.stringify(payload, null, 2), [expectedAuthToken]),
            },
          ],
        };
      } catch (err: unknown) {
        const sanitizedErr = sanitizeSecretText(
          err instanceof Error ? err.message : String(err),
          [expectedAuthToken]
        );
        recordAudit({
          timestamp: new Date().toISOString(),
          toolName: name,
          runId: activeRunId,
          durationMs: Date.now() - startTime,
          ok: false,
          summary: sanitizedErr,
        });
        return {
          content: [
            {
              type: "text",
              text: `Error executing tool "${name}": ${sanitizedErr}`,
            },
          ],
          isError: true,
        };
      }
    });

    return mcpServer;
  };

  const readJsonBody = (req: http.IncomingMessage): Promise<unknown> => {
    return new Promise((resolve, reject) => {
      let bodyLength = 0;
      const chunks: Buffer[] = [];
      let exceeded = false;

      req.on("data", (chunk: Buffer) => {
        bodyLength += chunk.length;
        if (bodyLength > maxBodySize) {
          exceeded = true;
          req.destroy();
          reject(Object.assign(new Error(`Payload Too Large: exceeded ${maxBodySize} bytes`), { statusCode: 413 }));
        } else {
          chunks.push(chunk);
        }
      });

      req.on("end", () => {
        if (exceeded) return;
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        if (!raw) {
          resolve(undefined);
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(Object.assign(new Error("Parse error: Invalid JSON"), { statusCode: 400 }));
        }
      });

      req.on("error", (err) => reject(err));
    });
  };

  const isAuthorized = (req: http.IncomingMessage): boolean => {
    const authHeader = req.headers["authorization"];
    const tokenHeader = req.headers["x-patchpilot-token"];
    let provided: string | null = null;
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      provided = authHeader.slice(7).trim();
    } else if (typeof tokenHeader === "string") {
      provided = tokenHeader.trim();
    }
    if (!provided) {
      return false;
    }
    return constantTimeTokenMatch(provided, expectedAuthToken);
  };

  const server = http.createServer(async (req, res) => {
    const reqUrl = (req.url || "/").split("?")[0];

    // 1. Lightweight loopback health probe (never exposes secrets or file contents)
    if (req.method === "GET" && reqUrl === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "healthy",
          server: config.serverName || "patchpilot-workspace",
          pid: process.pid,
          boundHost: host,
          workspaceName: path.basename(workspaceRoot),
          activeRunId: proposalStore.getActiveRunId(),
          pendingProposals: proposalStore.listProposals().length,
          timestamp: new Date().toISOString(),
        })
      );
      return;
    }

    // 2. Mandatory Bearer authentication for ALL MCP and control endpoints
    if (!isAuthorized(req)) {
      res.writeHead(401, {
        "Content-Type": "application/json",
        "WWW-Authenticate": 'Bearer realm="PatchPilot Workspace MCP"',
      });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Unauthorized: Invalid or missing Bearer token for PatchPilot Workspace MCP",
          },
          id: null,
        })
      );
      return;
    }

    // 3. Authenticated local extension control plane
    if (reqUrl.startsWith("/control/")) {
      try {
        if (req.method === "POST" && reqUrl === "/control/run") {
          const body = (await readJsonBody(req)) as {
            runId?: string | null;
            selectionConstraint?: InlineSelectionConstraint | null;
          };
          proposalStore.setActiveRun(body?.runId ?? null, body?.selectionConstraint);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, activeRunId: proposalStore.getActiveRunId() }));
          return;
        }

        if (req.method === "POST" && reqUrl === "/control/cancel") {
          const body = (await readJsonBody(req)) as { runId?: string } | undefined;
          const result = cancelActiveOperations(body?.runId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, ...result }));
          return;
        }

        if (req.method === "GET" && reqUrl === "/control/proposals") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ proposals: proposalStore.listProposals(), auditLog }));
          return;
        }

        if (req.method === "DELETE" && reqUrl === "/control/proposals") {
          const discarded = proposalStore.discardAllPending();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, discarded }));
          return;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unknown control route" }));
        return;
      } catch (err: unknown) {
        const statusCode = (err as { statusCode?: number }).statusCode || 500;
        res.writeHead(statusCode, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        return;
      }
    }

    // 4. Streamable HTTP MCP transport with multi-session support
    const sessionIdHeader =
      typeof req.headers["mcp-session-id"] === "string"
        ? req.headers["mcp-session-id"]
        : undefined;

    if (req.method === "POST") {
      try {
        const parsedBody = await readJsonBody(req);

        // Route to existing session if present
        if (sessionIdHeader && sessions.has(sessionIdHeader)) {
          const entry = sessions.get(sessionIdHeader)!;
          await entry.transport.handleRequest(req, res, parsedBody);
          return;
        }

        // Check if this is an MCP initialize request (or stateless single-shot)
        const isInitRequest =
          parsedBody &&
          typeof parsedBody === "object" &&
          ((parsedBody as { method?: string }).method === "initialize" ||
            (Array.isArray(parsedBody) &&
              parsedBody.some((item) => item && (item as { method?: string }).method === "initialize")));

        if (!isInitRequest && sessionIdHeader) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32000, message: "MCP session not found or expired." },
              id: null,
            })
          );
          return;
        }

        const mcpServer = buildMcpServerInstance();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: isInitRequest ? () => crypto.randomUUID() : undefined,
          onsessioninitialized: (sid: string) => {
            sessions.set(sid, { mcpServer, transport });
          },
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            sessions.delete(transport.sessionId);
          }
          mcpServer.close().catch(() => {});
        };

        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, parsedBody);

        if (!isInitRequest) {
          // Clean up one-off stateless transport once response completes
          res.on("close", () => {
            transport.close().catch(() => {});
            mcpServer.close().catch(() => {});
          });
        }
        return;
      } catch (err: unknown) {
        const statusCode = (err as { statusCode?: number }).statusCode || 500;
        if (!res.headersSent) {
          res.writeHead(statusCode, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: statusCode === 400 ? -32700 : -32603,
                message: sanitizeSecretText(err instanceof Error ? err.message : String(err), [
                  expectedAuthToken,
                ]),
              },
              id: null,
            })
          );
        }
        return;
      }
    }

    if (req.method === "GET") {
      if (!sessionIdHeader || !sessions.has(sessionIdHeader)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing or invalid mcp-session-id for GET SSE stream." }));
        return;
      }
      try {
        await sessions.get(sessionIdHeader)!.transport.handleRequest(req, res);
      } catch (err: unknown) {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      }
      return;
    }

    if (req.method === "DELETE") {
      if (sessionIdHeader && sessions.has(sessionIdHeader)) {
        const entry = sessions.get(sessionIdHeader)!;
        sessions.delete(sessionIdHeader);
        await entry.transport.close().catch(() => {});
        await entry.mcpServer.close().catch(() => {});
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ closed: true }));
      return;
    }

    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method Not Allowed" }));
  });

  return new Promise<RunningWorkspaceMcpServer>((resolve, reject) => {
    server.on("error", reject);
    server.listen(config.port ?? 0, host, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Unable to obtain listening address for PatchPilot MCP server."));
        return;
      }

      const boundPort = addr.port;
      const controlBaseUrl = `http://${host}:${boundPort}`;
      const url = `${controlBaseUrl}/mcp`;

      resolve({
        host,
        port: boundPort,
        url,
        controlBaseUrl,
        workspaceRoot,
        proposalStore,
        authToken: expectedAuthToken,
        server,
        getAuditLog: () => [...auditLog],
        cancelActiveOperations,
        stop: async () => {
          cancelActiveOperations();
          for (const [, entry] of sessions) {
            await entry.transport.close().catch(() => {});
            await entry.mcpServer.close().catch(() => {});
          }
          sessions.clear();
          await new Promise<void>((res) => server.close(() => res()));
        },
      });
    });
  });
}
