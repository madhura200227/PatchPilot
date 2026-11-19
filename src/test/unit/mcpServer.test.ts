import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  createWorkspaceMcpServer,
  PATCHPILOT_MCP_TOOL_NAMES,
  RunningWorkspaceMcpServer,
} from "../../workspace/mcpServerCore";
import { WorkspaceProcessManager } from "../../workspace/WorkspaceProcessManager";
import { ProposalStore } from "../../workspace/proposalStore";
import { MockLogger } from "../testHelpers";

describe("Unit/Local Integration: Production Workspace MCP Server & Process Manager", () => {
  let tmpWs: string;
  let server: RunningWorkspaceMcpServer | null = null;
  const authToken = "sec-patchpilot-unit-test-token-1234567890";

  beforeEach(() => {
    tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "patchpilot-mcp-unit-"));
    fs.mkdirSync(path.join(tmpWs, "src"), { recursive: true });
    fs.mkdirSync(path.join(tmpWs, "tests"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpWs, "src", "calc.mjs"),
      "export function add(a, b) {\n  return a - b;\n}\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(tmpWs, "tests", "calc.test.mjs"),
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/calc.mjs';\ntest('add', () => assert.equal(add(2, 3), 5));\n",
      "utf8"
    );
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
      server.proposalStore.cleanup();
      server = null;
    }
    fs.rmSync(tmpWs, { recursive: true, force: true });
  });

  it("should enforce Bearer auth, expose all 8 annotated tools, support multi-session clients, propose edits without writing disk, and verify in overlay", async () => {
    server = await createWorkspaceMcpServer({
      host: "127.0.0.1",
      port: 0,
      authToken,
      workspaceRoot: tmpWs,
    });

    // 1. Unauthenticated request must return HTTP 401
    const unauth = await fetch(server.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.strictEqual(unauth.status, 401);

    // 2. Connect MCP Client #1 (like TrueForge listTools)
    const client1 = new Client({ name: "test-client-1", version: "1.0.0" }, { capabilities: {} });
    const transport1 = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${authToken}` } },
    });
    await client1.connect(transport1);

    const listed = await client1.listTools();
    const names = listed.tools.map((t) => t.name).sort();
    assert.deepStrictEqual(names, [...PATCHPILOT_MCP_TOOL_NAMES].sort());

    const proposeTool = listed.tools.find((t) => t.name === "propose_edit");
    assert.strictEqual(proposeTool?.annotations?.readOnlyHint, false);
    const readTool = listed.tools.find((t) => t.name === "read_workspace_file");
    assert.strictEqual(readTool?.annotations?.readOnlyHint, true);

    await client1.close();

    // 3. Connect MCP Client #2 (proves multi-session initialization works cleanly!)
    const client2 = new Client({ name: "test-client-2", version: "1.0.0" }, { capabilities: {} });
    const transport2 = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${authToken}` } },
    });
    await client2.connect(transport2);

    const searchRes = await client2.callTool({
      name: "search_workspace",
      arguments: { query: "add function calc" },
    });
    const searchText = (searchRes.content as Array<{ text: string }>)[0].text;
    assert.ok(searchText.includes("src/calc.mjs"));

    const symRes = await client2.callTool({
      name: "read_workspace_symbol",
      arguments: { symbol: "add" },
    });
    const symText = (symRes.content as Array<{ text: string }>)[0].text;
    assert.ok(symText.includes("src/calc.mjs"));

    const planRes = await client2.callTool({
      name: "get_context_plan",
      arguments: { query: "Fix add function in calc" },
    });
    const planText = (planRes.content as Array<{ text: string }>)[0].text;
    assert.ok(planText.includes("Estimated context budget"));

    const propRes = await client2.callTool({
      name: "propose_edit",
      arguments: {
        path: "src/calc.mjs",
        content: "export function add(a, b) {\n  return a + b;\n}\n",
        summary: "Fix subtraction bug in add()",
      },
    });
    const propJson = JSON.parse((propRes.content as Array<{ text: string }>)[0].text) as {
      proposalId: string;
      hunkCount: number;
    };
    assert.ok(propJson.proposalId.startsWith("prop-"));
    assert.strictEqual(propJson.hunkCount, 1);

    // Host workspace must STILL have the original bug!
    assert.ok(fs.readFileSync(path.join(tmpWs, "src", "calc.mjs"), "utf8").includes("return a - b;"));

    // Run tests in disposable overlay via MCP tool -> must PASS against the proposal!
    const cmdRes = await client2.callTool({
      name: "run_workspace_command",
      arguments: { executable: "node", args: ["--test", "tests/calc.test.mjs"] },
    });
    const cmdJson = JSON.parse((cmdRes.content as Array<{ text: string }>)[0].text) as {
      passed: boolean;
      overlayCleanedUp: boolean;
    };
    assert.strictEqual(cmdJson.passed, true);
    assert.strictEqual(cmdJson.overlayCleanedUp, true);

    await client2.close();
  });

  it("should spawn out-of-process dist/mcpServer.js via WorkspaceProcessManager with IPC token handoff and stop cleanly", async () => {
    const logger = new MockLogger();
    const procMgr = new WorkspaceProcessManager(logger);
    const store = new ProposalStore(tmpWs);
    const scriptPath = path.resolve(process.cwd(), "dist", "mcpServer.js");

    try {
      const status = await procMgr.start({
        workspaceRoot: tmpWs,
        proposalStoreDir: store.getStoreDir(),
        serverScriptPath: scriptPath,
      });

      assert.strictEqual(status.state, "running");
      assert.strictEqual(status.host, "127.0.0.1");
      assert.ok(status.port && status.port > 0);
      assert.ok(status.pid && status.pid > 0);

      const health = await procMgr.checkHealth();
      assert.strictEqual(health.healthy, true);

      await procMgr.stop();
      assert.strictEqual(procMgr.getStatus().state, "stopped");
    } finally {
      await procMgr.stop();
      store.cleanup();
    }
  });
});
