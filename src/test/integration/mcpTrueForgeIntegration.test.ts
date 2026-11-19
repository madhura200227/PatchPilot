import assert from "node:assert";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { TrueForgeResolvedConfig } from "../../config/configuration";
import { ExtensionState } from "../../state/extensionState";
import { TrueForgeAgentManager } from "../../trueforge/agentManager";
import { CancellationManager } from "../../trueforge/cancellationManager";
import { TrueForgeClientFactory } from "../../trueforge/clientFactory";
import { ConnectionManager } from "../../trueforge/connectionManager";
import { SessionManager } from "../../trueforge/sessionManager";
import { TurnStreamManager } from "../../trueforge/turnStream";
import { PATCHPILOT_MCP_TOOL_NAMES } from "../../workspace/mcpServerCore";
import { WorkspaceMcpAdapter } from "../../workspace/WorkspaceMcpAdapter";
import { MockLogger } from "../testHelpers";

async function probeUrl(urlStr: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const url = new URL(urlStr);
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port || 8790,
          path: "/api/v1/sessions?limit=1",
          method: "GET",
          timeout: 2500,
        },
        (res) => resolve(res.statusCode !== undefined && res.statusCode < 500)
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    } catch {
      resolve(false);
    }
  });
}

async function detectTrueForgeBaseUrl(): Promise<string | null> {
  const candidates = process.env.TRUEFORGE_SERVER_URL
    ? [process.env.TRUEFORGE_SERVER_URL]
    : ["http://127.0.0.1:8790", "http://localhost:8790"];
  for (const url of candidates) {
    if (await probeUrl(url)) {
      return url;
    }
  }
  return null;
}

describe("Integration: Production MCP Server + TrueForge Agent, Context Engineering & Task C Resilience", function () {
  this.timeout(60000);

  const clientFactory = new TrueForgeClientFactory();
  let detectedBaseUrl: string | null = null;
  let tmpWorkspace: string;
  let mcpAdapter: WorkspaceMcpAdapter | null = null;
  let createdAgentId: string | undefined;
  let createdSessionId: string | undefined;
  let createdTempProviderName: string | undefined;
  const connectorName = "patchpilot-mvp-it";
  const agentName = "patchpilot-mvp-it-agent";

  const getConfig = (): TrueForgeResolvedConfig => ({
    baseUrl: detectedBaseUrl || "http://127.0.0.1:8790",
    agentName,
    mcpConnectorName: connectorName,
    requestTimeoutSeconds: 20,
  });

  before(async () => {
    detectedBaseUrl = await detectTrueForgeBaseUrl();
    tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "patchpilot-tf-it-"));
    fs.mkdirSync(path.join(tmpWorkspace, "src"), { recursive: true });
    fs.mkdirSync(path.join(tmpWorkspace, "tests"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpWorkspace, "src", "helpers.py"),
      'import os\n\ndef get_debug_flag() -> bool:\n    val = os.environ.get("FLASK_DEBUG")\n    return bool(val and val.lower() not in {"0", "false", "no"})\n',
      "utf8"
    );
    fs.writeFileSync(
      path.join(tmpWorkspace, "tests", "test_helpers.py"),
      "def test_placeholder():\n    assert True\n",
      "utf8"
    );
  });

  after(async () => {
    const cfg = getConfig();
    const client = clientFactory.createClient(cfg);
    if (createdSessionId) {
      await client.sessions.delete(createdSessionId).catch(() => {});
    }
    if (createdAgentId) {
      await client.agents.delete(createdAgentId).catch(() => {});
    }
    if (detectedBaseUrl) {
      await client.settings.mcpServers.delete(connectorName).catch(() => {});
    }
    if (createdTempProviderName) {
      await client.settings.modelProviders.delete(createdTempProviderName).catch(() => {});
    }
    if (mcpAdapter) {
      await mcpAdapter.dispose();
    }
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  });

  it("1. Task C Resilience (Unreachable Endpoint): Fails cleanly with SERVER_NOT_RUNNING and zero workspace mutations", async () => {
    const targetFile = path.join(tmpWorkspace, "src", "helpers.py");
    const beforeContent = fs.readFileSync(targetFile, "utf8");

    const state = new ExtensionState();
    const logger = new MockLogger();
    const connMgr = new ConnectionManager(clientFactory, state, logger);

    const unreachableConfig: TrueForgeResolvedConfig = {
      baseUrl: "http://127.0.0.1:18798",
      agentName: "patchpilot",
      requestTimeoutSeconds: 3,
    };

    const check = await connMgr.checkConnection(unreachableConfig);
    assert.strictEqual(check.status, "CONNECTION_FAILED");
    assert.strictEqual(check.diagnosticState, "SERVER_NOT_RUNNING");
    assert.strictEqual(fs.readFileSync(targetFile, "utf8"), beforeContent);
    console.log(`[TASK C PASS - UNREACHABLE] Diagnostic=${check.diagnosticState}; workspace unchanged.`);
  });

  it("2. Real TrueForge: Start out-of-process MCP server, register connector, and verify discovery of all 8 tools", async function () {
    if (!detectedBaseUrl) {
      console.warn("[BLOCKED] TrueForge server not reachable on 127.0.0.1:8790 or localhost:8790");
      this.skip();
      return;
    }

    const cfg = getConfig();
    const logger = new MockLogger();
    mcpAdapter = new WorkspaceMcpAdapter(clientFactory, logger, process.cwd());
    const procStatus = await mcpAdapter.ensureStarted(tmpWorkspace);
    assert.strictEqual(procStatus.state, "running");

    const reg = await mcpAdapter.registerWithTrueForge(cfg, connectorName);
    assert.strictEqual(
      reg.registered,
      true,
      `Connector registration failed (ensure OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'): ${reg.error}`
    );
    assert.deepStrictEqual(reg.discoveredTools, [...PATCHPILOT_MCP_TOOL_NAMES].sort());
    console.log(
      `[REAL TRUEFORGE PASS] Base=${detectedBaseUrl}; registered connector "${connectorName}" (${reg.endpointUrl}); discovered all 8 tools: [${reg.discoveredTools.join(", ")}]`
    );
  });

  it("3. Real TrueForge: Persist PatchPilot agent with context engineering, execute real turn, verify Task C invalid-key resilience, and cancel cleanly", async function () {
    if (!detectedBaseUrl) {
      this.skip();
      return;
    }

    const cfg = getConfig();
    const logger = new MockLogger();
    const state = new ExtensionState();
    const client = clientFactory.createClient(cfg);
    const connMgr = new ConnectionManager(clientFactory, state, logger);
    const agentMgr = new TrueForgeAgentManager(clientFactory, logger, process.cwd());

    // First verify connection check reports MODEL_NOT_CONFIGURED accurately when 0 models exist
    const preCheck = await connMgr.checkConnection(cfg);
    let selectedModel = preCheck.availableModels[0]?.name;
    let usingInvalidTestKey = false;

    if (!selectedModel) {
      assert.strictEqual(preCheck.diagnosticState, "MODEL_NOT_CONFIGURED");
      console.log(
        "[REAL TRUEFORGE PASS] ConnectionManager accurately reported MODEL_NOT_CONFIGURED on unconfigured server."
      );

      // Register a temporary invalid-key provider strictly to verify Agent schema persistence,
      // real Session/Turn creation, and Task C invalid-key resilience (cleaned up in after()).
      await client.settings.modelProviders.createOrUpdate({
        manifest: {
          type: "openai",
          auth: { apiKey: "sk-invalid-task-c-resilience-check-only" },
          models: [
            {
              name: "gpt-4o",
              modelId: "gpt-4o",
              properties: {},
            },
          ],
        },
      });
      createdTempProviderName = "openai";
      selectedModel = "openai/gpt-4o";
      usingInvalidTestKey = true;
    }

    // Create PatchPilot agent on real TrueForge server and verify exact context-engineering persistence
    const ensured = await agentMgr.ensurePatchPilotAgent(cfg, {
      modelName: selectedModel,
      agentName,
      mcpConnectorName: connectorName,
    });
    createdAgentId = ensured.agentId;

    const fetchedAgent = await client.agents.get(createdAgentId);
    assert.strictEqual(fetchedAgent.data.manifest.mcpServers?.[0]?.preload, false);
    assert.deepStrictEqual(fetchedAgent.data.manifest.mcpServers?.[0]?.requireApprovalForTools, [
      "propose_edit",
      "run_workspace_command",
    ]);
    assert.strictEqual(
      fetchedAgent.data.manifest.config?.contextManagement?.compaction?.enabled,
      true
    );
    assert.strictEqual(
      fetchedAgent.data.manifest.config?.contextManagement?.largeToolResponse?.enabled,
      true
    );
    console.log(
      `[REAL TRUEFORGE PASS] Agent "${agentName}" (${createdAgentId}) persisted with model="${selectedModel}", preload=false, compaction=true, largeToolResponse=true, approvals=[propose_edit, run_workspace_command].`
    );

    // Create real session referencing the named PatchPilot agent
    const sessionMgr = new SessionManager(clientFactory, state, logger);
    createdSessionId = await sessionMgr.createSession(cfg, { forceNew: true });
    assert.ok(createdSessionId && createdSessionId.length > 10);

    // Execute real turn against TrueForge
    const targetFile = path.join(tmpWorkspace, "src", "helpers.py");
    const beforeContent = fs.readFileSync(targetFile, "utf8");
    const streamMgr = new TurnStreamManager(clientFactory, state, logger);
    const turnRes = await streamMgr.executeTurn(
      cfg,
      createdSessionId,
      "Inspect src/helpers.py and report what get_debug_flag currently returns."
    );

    console.log(
      `[REAL TRUEFORGE TURN] SessionId=${createdSessionId} TurnId=${turnRes.turnId || "none"} TerminalStatus=${turnRes.terminalStatus} Events=${turnRes.eventsCount} Retries=${turnRes.retriesPerformed} Error=${turnRes.error || "none"}`
    );

    if (usingInvalidTestKey) {
      // Task C (Invalid Key Resilience): must fail cleanly with 0 retries on 401 and 0 workspace edits
      assert.strictEqual(turnRes.terminalStatus, "ERROR");
      assert.strictEqual(turnRes.retriesPerformed, 0, "Must not retry 401 authentication failure");
      assert.strictEqual(fs.readFileSync(targetFile, "utf8"), beforeContent);
      console.log(
        "[TASK C PASS - INVALID KEY] TrueForge returned model auth error cleanly; 0 retries, 0 workspace mutations. Real model-backed execution remains BLOCKED (no valid upstream provider key in environment)."
      );
    } else {
      assert.strictEqual(turnRes.terminalStatus, "COMPLETED");
      console.log("[REAL TRUEFORGE PASS] Live model-backed turn completed successfully!");
    }

    // Verify cancellation endpoint handling on live server
    const cancelMgr = new CancellationManager(clientFactory, state, logger);
    const cancelRes = await cancelMgr.cancelActiveTurn(cfg, {
      cancelLocalMcp: (runId) => mcpAdapter!.cancelActiveOperations(runId),
    });
    assert.strictEqual(cancelRes.serverAccepted, true);
    console.log(
      `[REAL TRUEFORGE PASS] Cancellation endpoint verified (serverAccepted=${cancelRes.serverAccepted}, authoritativeStatus=${cancelRes.authoritativeStatus}).`
    );
  });
});
