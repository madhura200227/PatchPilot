import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  listWorkspaceFiles,
  readWorkspaceFile,
  writeWorkspaceFile,
  runWorkspaceTests,
  getWorkspaceStatus,
} from "./workspaceTools.js";

export const WORKSPACE_TOOLS = [
  {
    name: "list_workspace_files",
    description: "List permitted files and directories inside the isolated workspace fixture.",
    inputSchema: {
      type: "object",
      properties: {
        directory: {
          type: "string",
          description: "Relative directory path inside workspace (defaults to root '.')",
        },
      },
    },
  },
  {
    name: "read_workspace_file",
    description: "Read content and SHA-256 hash of a file inside the isolated workspace fixture.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative file path to read inside workspace fixture",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_workspace_file",
    description: "Write content to a file inside the isolated workspace fixture. Rejects unsafe paths and disallowed file extensions.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative file path to write inside workspace fixture",
        },
        content: {
          type: "string",
          description: "File content to write",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "run_workspace_tests",
    description: "Run the deterministic predefined test command for the workspace fixture. Fixed executable and timeout protection applied.",
    inputSchema: {
      type: "object",
      properties: {
        testFile: {
          type: "string",
          description: "Optional relative test file path (defaults to tests/calculator.test.mjs)",
        },
      },
    },
  },
  {
    name: "get_workspace_status",
    description: "Get Git status and list of modified and untracked files strictly within the workspace fixture.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

export function registerWorkspaceTools(server: Server, workspaceRoot: string): void {
  // 1. Register tools list handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: WORKSPACE_TOOLS,
    };
  });

  // 2. Register tool execution handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case "list_workspace_files": {
          const directory = (args && typeof args.directory === "string") ? args.directory : ".";
          const files = await listWorkspaceFiles(workspaceRoot, directory);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ directory, count: files.length, files }, null, 2),
              },
            ],
          };
        }

        case "read_workspace_file": {
          if (!args || typeof args.path !== "string") {
            throw new Error("Missing required argument 'path' for read_workspace_file");
          }
          const file = await readWorkspaceFile(workspaceRoot, args.path);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(file, null, 2),
              },
            ],
          };
        }

        case "write_workspace_file": {
          if (!args || typeof args.path !== "string") {
            throw new Error("Missing required argument 'path' for write_workspace_file");
          }
          if (typeof args.content !== "string") {
            throw new Error("Missing required argument 'content' for write_workspace_file");
          }
          const result = await writeWorkspaceFile(workspaceRoot, args.path, args.content);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case "run_workspace_tests": {
          const testFile = (args && typeof args.testFile === "string") ? args.testFile : undefined;
          const result = await runWorkspaceTests(workspaceRoot, testFile);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case "get_workspace_status": {
          const status = await getWorkspaceStatus(workspaceRoot);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(status, null, 2),
              },
            ],
          };
        }

        default:
          return {
            content: [
              {
                type: "text",
                text: `Unknown tool "${name}". Supported tools: ${WORKSPACE_TOOLS.map((t) => t.name).join(", ")}`,
              },
            ],
            isError: true,
          };
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text",
            text: `Error executing tool "${name}": ${errMsg}`,
          },
        ],
        isError: true,
      };
    }
  });
}
