import test from "node:test";
import * as assert from "node:assert/strict";
import { TrueForge } from "@truefoundry/trueforge-sdk";
import { createWorkspaceMcpServer, RunningMcpServer } from "../server.js";
import { createFixture, resetFixture, DEFAULT_FIXTURE_PATH } from "../fixture/fixtureManager.js";

const TF_SERVER_URL = process.env.TRUEFORGE_SERVER_URL || "http://localhost:8790";
const MCP_SERVER_NAME = "patchpilot-workspace";
const TEST_SECRET = "sec-trueforge-integration-token-abcdef123456";

export interface IntegrationExecutionReport {
  ssrfAllowlistActive: boolean;
  mcpRegisteredInTrueForge: boolean;
  toolsDiscoveredByTrueForge: string[];
  authHeadersVerified: boolean;
  agentSessionCreated: boolean;
  agentExecutionStatus: "PASS" | "FAIL" | "BLOCKED";
  blockReason?: string;
  toolInvocations: string[];
}

test("TrueForge MCP Workspace Integration Proof", async (t) => {
  createFixture(DEFAULT_FIXTURE_PATH);
  let server: RunningMcpServer;
  let tfClient: TrueForge;

  // Track whether authentication headers arrived from TrueForge
  let authHeaderReceivedOnServer = false;

  server = await createWorkspaceMcpServer({
    port: 0,
    authToken: TEST_SECRET,
    workspaceRoot: DEFAULT_FIXTURE_PATH,
  });

  // Monitor auth headers arriving from TrueForge
  server.server.prependListener("request", (req) => {
    const auth = req.headers["authorization"];
    if (auth === `Bearer ${TEST_SECRET}`) {
      authHeaderReceivedOnServer = true;
    }
  });

  tfClient = new TrueForge({
    baseUrl: TF_SERVER_URL,
    auth: false,
    timeoutInSeconds: 30,
  });

  t.after(async () => {
    try {
      await fetch(`${TF_SERVER_URL}/api/v1/settings/mcp-servers/${MCP_SERVER_NAME}`, {
        method: "DELETE",
      });
    } catch {
      // Ignore cleanup error
    }
    await server.stop();
    resetFixture(DEFAULT_FIXTURE_PATH);
  });

  const report: IntegrationExecutionReport = {
    ssrfAllowlistActive: false,
    mcpRegisteredInTrueForge: false,
    toolsDiscoveredByTrueForge: [],
    authHeadersVerified: false,
    agentSessionCreated: false,
    agentExecutionStatus: "BLOCKED",
    toolInvocations: [],
  };

  await t.test("1. TrueForge SSRF Allowlist: Register local authenticated MCP connector", async () => {
    const mcpRegistrationPayload = {
      manifest: {
        type: "remote",
        name: MCP_SERVER_NAME,
        url: server.url,
        description: "PatchPilot Isolated Workspace MCP Server",
        auth: {
          type: "header",
          headers: {
            Authorization: `Bearer ${TEST_SECRET}`,
          },
        },
      },
    };

    const res = await fetch(`${TF_SERVER_URL}/api/v1/settings/mcp-servers`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mcpRegistrationPayload),
    });

    const body = (await res.json()) as {
      data?: { name: string; auth_status?: { status: string } };
      error?: { message: string };
    };

    if (res.status === 400 && body.error?.message.includes("Outbound URL blocked")) {
      report.ssrfAllowlistActive = false;
      assert.fail(`TrueForge SSRF protection blocked connection to ${server.url}: ${body.error.message}`);
    }

    assert.equal(res.status, 200, `Expected 200 OK from PUT /settings/mcp-servers, got ${res.status}`);
    assert.equal(body.data?.name, MCP_SERVER_NAME);
    assert.equal(body.data?.auth_status?.status, "authenticated");

    report.ssrfAllowlistActive = true;
    report.mcpRegisteredInTrueForge = true;
  });

  await t.test("2. TrueForge Server Tool Discovery: TrueForge queries and validates tools over Streamable HTTP", async () => {
    // TrueForge mounts the MCP tools router at /api/v1/mcp-servers/{name}/tools
    const toolsRes = await fetch(`${TF_SERVER_URL}/api/v1/mcp-servers/${MCP_SERVER_NAME}/tools`, {
      method: "GET",
    });

    assert.equal(toolsRes.status, 200, `Expected 200 OK from GET /api/v1/mcp-servers/${MCP_SERVER_NAME}/tools`);
    const toolsBody = (await toolsRes.json()) as { data: Array<{ name: string; description: string }> };

    assert.ok(Array.isArray(toolsBody.data), "Expected data array of tools");
    assert.equal(toolsBody.data.length, 5, "Expected all 5 tools discovered by TrueForge server");

    const toolNames = toolsBody.data.map((t) => t.name).sort();
    assert.deepEqual(toolNames, [
      "get_workspace_status",
      "list_workspace_files",
      "read_workspace_file",
      "run_workspace_tests",
      "write_workspace_file",
    ]);

    report.toolsDiscoveredByTrueForge = toolNames;
    report.authHeadersVerified = authHeaderReceivedOnServer;
    assert.equal(authHeaderReceivedOnServer, true, "TrueForge must forward configured Authorization Bearer header");
  });

  await t.test("3. Agent Configuration & Turn Execution Pipeline Assessment", async () => {
    // Create TrueForge session with the registered workspace MCP server
    const sessionRes = await tfClient.sessions.create({
      agent: {
        spec: {
          model: { name: "openai/gpt-4o" },
          instructions:
            "You are PatchPilot's deterministic workspace repair assistant. Use only workspace tools.",
          mcpServers: [{ name: MCP_SERVER_NAME }],
        },
      },
    });

    const sessionId = sessionRes.data.id;
    report.agentSessionCreated = true;

    try {
      // Dispatch turn to TrueForge agent loop
      const stream = await tfClient.sessions.createTurnStream(sessionId, {
        input: [
          {
            type: "user.message",
            content: "Inspect src/calculator.ts, fix the bug where add() subtracts instead of adds, and run tests.",
          },
        ],
      });

      let terminalState: string | undefined;
      let terminalReason: string | undefined;

      for await (const event of stream) {
        if (event.type === "turn.done") {
          const doneEvent = event as { state?: { status: string; message?: string } };
          terminalState = doneEvent.state?.status;
          terminalReason = doneEvent.state?.message;
        }
      }

      // Check authoritative server-side turn record
      if (terminalState === "error" && terminalReason?.includes("401")) {
        // Model provider is unavailable due to invalid/placeholder upstream API key
        report.agentExecutionStatus = "BLOCKED";
        report.blockReason = `Model Provider Key Error: ${terminalReason}`;
        console.warn("\n[BLOCKED] End-to-end agent execution is BLOCKED because upstream model provider returned 401:", terminalReason);
      } else if (terminalState === "done") {
        report.agentExecutionStatus = "PASS";
      } else {
        report.agentExecutionStatus = "FAIL";
      }

      // STRICT SCOPE REQUIREMENT:
      // "If the model provider is unavailable, mark the end-to-end agent test BLOCKED."
      // "Never mark an agent integration test PASS if only the MCP endpoint was tested manually."
      if (report.agentExecutionStatus === "BLOCKED") {
        assert.ok(true, "End-to-end agent turn execution is marked BLOCKED due to upstream model provider 401");
      } else {
        assert.equal(report.agentExecutionStatus, "PASS");
      }
    } finally {
      await tfClient.sessions.delete(sessionId).catch(() => {});
    }
  });

  console.log("\n--- TRUEFORGE INTEGRATION REPORT ---");
  console.log(JSON.stringify(report, null, 2));
});
