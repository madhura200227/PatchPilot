import test from "node:test";
import * as assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createWorkspaceMcpServer, RunningMcpServer } from "../server.js";
import { createFixture, resetFixture, DEFAULT_FIXTURE_PATH } from "../fixture/fixtureManager.js";

const TEST_SECRET = "sec-mcp-protocol-test-token-87654321";

interface ToolTextContent {
  type: string;
  text: string;
}

function getTextContent(content: unknown): string {
  const arr = content as ToolTextContent[];
  if (!Array.isArray(arr) || arr.length === 0 || !arr[0]) {
    throw new Error("Missing content in tool response");
  }
  return arr[0].text;
}

test("MCP Protocol & Direct Transport Test Suite", async (t) => {
  createFixture(DEFAULT_FIXTURE_PATH);
  let server: RunningMcpServer;
  let client: Client;
  let transport: StreamableHTTPClientTransport;

  server = await createWorkspaceMcpServer({
    port: 0,
    authToken: TEST_SECRET,
    workspaceRoot: DEFAULT_FIXTURE_PATH,
  });

  // Connect official MCP Client over Streamable HTTP Transport with auth headers
  transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${TEST_SECRET}`,
      },
    },
  });

  client = new Client(
    { name: "test-mcp-protocol-client", version: "1.0.0" },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);
    console.log("Client connected successfully!");
  } catch (err: unknown) {
    console.error("CLIENT CONNECT FAILED:", err);
    throw err;
  }

  t.after(async () => {
    await client.close();
    await server.stop();
    resetFixture(DEFAULT_FIXTURE_PATH);
  });

  await t.test("1. tools/list returns all 5 required tools with schemas", async () => {
    const response = await client.listTools();
    assert.ok(Array.isArray(response.tools), "Expected tools array");
    assert.equal(response.tools.length, 5, "Expected exactly 5 tools registered");

    const toolNames = response.tools.map((t) => t.name).sort();
    assert.deepEqual(toolNames, [
      "get_workspace_status",
      "list_workspace_files",
      "read_workspace_file",
      "run_workspace_tests",
      "write_workspace_file",
    ]);

    for (const tool of response.tools) {
      assert.ok(tool.description && tool.description.length > 0, `Tool ${tool.name} missing description`);
      assert.equal(tool.inputSchema.type, "object", `Tool ${tool.name} inputSchema must be object`);
    }
  });

  await t.test("2. list_workspace_files returns fixture contents", async () => {
    const result = await client.callTool({
      name: "list_workspace_files",
      arguments: { directory: "." },
    });

    assert.equal(result.isError, undefined);
    const text = getTextContent(result.content);
    const parsed = JSON.parse(text);

    assert.ok(parsed.count >= 5);
    const fileNames = parsed.files.map((f: { name: string }) => f.name);
    assert.ok(fileNames.includes("package.json"));
    assert.ok(fileNames.includes("src"));
    assert.ok(fileNames.includes("tests"));
    assert.ok(!fileNames.includes(".git"), ".git must never be exposed");
  });

  await t.test("3. read_workspace_file returns content and SHA-256 hash", async () => {
    const result = await client.callTool({
      name: "read_workspace_file",
      arguments: { path: "src/calculator.ts" },
    });

    assert.equal(result.isError, undefined);
    const text = getTextContent(result.content);
    const parsed = JSON.parse(text);

    assert.equal(parsed.path, "src/calculator.ts");
    assert.ok(parsed.content.includes("export function add"));
    assert.ok(parsed.content.includes("return a - b;")); // Buggy version
    assert.equal(typeof parsed.sha256, "string");
    assert.equal(parsed.sha256.length, 64, "SHA-256 must be 64 hex characters");
  });

  await t.test("4. run_workspace_tests detects intentional bug in fixture", async () => {
    const result = await client.callTool({
      name: "run_workspace_tests",
      arguments: {},
    });

    const text = getTextContent(result.content);
    const parsed = JSON.parse(text);

    assert.equal(parsed.passed, false, "Initial test must fail due to deliberate bug");
    assert.notEqual(parsed.exitCode, 0);
    assert.ok(parsed.stdout.includes("calculator add function returns correct sum") || parsed.stdout.includes("Expected add(2, 3) to be 5"));
  });

  await t.test("5. write_workspace_file safely updates file inside fixture", async () => {
    const fixedContent = `/**
 * Deterministic Calculator for PatchPilot MCP Fixture (Fixed)
 */
export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}
`;

    const writeResult = await client.callTool({
      name: "write_workspace_file",
      arguments: {
        path: "src/calculator.ts",
        content: fixedContent,
      },
    });

    assert.equal(writeResult.isError, undefined);
    const writeParsed = JSON.parse(getTextContent(writeResult.content));
    assert.equal(writeParsed.success, true);
    assert.equal(writeParsed.path, "src/calculator.ts");

    // Re-read file to verify content and new SHA-256 hash
    const readResult = await client.callTool({
      name: "read_workspace_file",
      arguments: { path: "src/calculator.ts" },
    });
    const readParsed = JSON.parse(getTextContent(readResult.content));
    assert.equal(readParsed.sha256, writeParsed.sha256);
    assert.ok(readParsed.content.includes("return a + b;"));
  });

  await t.test("6. run_workspace_tests passes after calculator bug is resolved", async () => {
    const result = await client.callTool({
      name: "run_workspace_tests",
      arguments: {},
    });

    const text = getTextContent(result.content);
    const parsed = JSON.parse(text);

    assert.equal(parsed.passed, true, "Tests must pass after bug fix");
    assert.equal(parsed.exitCode, 0);
  });

  await t.test("7. get_workspace_status reports modified files within fixture", async () => {
    const result = await client.callTool({
      name: "get_workspace_status",
      arguments: {},
    });

    const text = getTextContent(result.content);
    const parsed = JSON.parse(text);

    assert.equal(parsed.clean, false);
    assert.ok(parsed.modifiedFiles.some((f: string) => f.includes("src/calculator.ts")));
  });

  await t.test("8. Invoking unknown tool returns isError contract", async () => {
    const result = await client.callTool({
      name: "unauthorized_arbitrary_command",
      arguments: { command: "rm -rf /" },
    });

    assert.equal(result.isError, true);
    const text = getTextContent(result.content);
    assert.match(text, /Unknown tool/i);
  });
});
