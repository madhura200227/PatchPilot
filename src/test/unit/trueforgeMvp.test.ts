import assert from "node:assert";
import * as path from "node:path";
import { TrueForge } from "@truefoundry/trueforge-sdk";
import { TrueForgeAgentManager } from "../../trueforge/agentManager";
import { ApprovalManager } from "../../trueforge/approvalManager";
import { ConnectionManager } from "../../trueforge/connectionManager";
import { TurnStreamManager, isRetryableTrueForgeError } from "../../trueforge/turnStream";
import { CancellationManager } from "../../trueforge/cancellationManager";
import { ExtensionState } from "../../state/extensionState";
import { TrueForgeResolvedConfig } from "../../config/configuration";
import { ITrueForgeClientFactory } from "../../trueforge/clientFactory";
import { MockLogger } from "../testHelpers";

describe("Unit: TrueForge MVP Integration (AgentManager, ApprovalManager, Diagnostics, Retry, Cancel)", () => {
  const baseConfig: TrueForgeResolvedConfig = {
    baseUrl: "http://127.0.0.1:8790",
    agentName: "patchpilot",
    requestTimeoutSeconds: 30,
    mcpConnectorName: "patchpilot-workspace",
  };

  it("should build AgentSpec with deferred loading (preload: false), compaction, largeToolResponse, and literal approval tools", () => {
    const logger = new MockLogger();
    const factory: ITrueForgeClientFactory = { createClient: () => ({} as TrueForge) };
    const agentMgr = new TrueForgeAgentManager(factory, logger, process.cwd());

    const template = agentMgr.loadAgentTemplate();
    assert.ok(template, "agents/patchpilot.agent.json template must load");
    assert.strictEqual(template.manifest.mcp_servers[0].preload, false);
    assert.strictEqual(template.manifest.config.context_management.compaction.enabled, true);
    assert.strictEqual(template.manifest.config.context_management.large_tool_response.enabled, true);

    const spec = agentMgr.buildPatchPilotAgentSpec({ modelName: "openai/gpt-5-mini" });
    assert.strictEqual(spec.model.name, "openai/gpt-5-mini");
    assert.strictEqual(spec.mcpServers?.[0].preload, false);
    assert.deepStrictEqual(spec.mcpServers?.[0].requireApprovalForTools, [
      "propose_edit",
      "run_workspace_command",
    ]);
    assert.strictEqual(spec.config?.contextManagement?.compaction?.enabled, true);
    assert.strictEqual(spec.config?.contextManagement?.largeToolResponse?.enabled, true);
  });

  it("should detect MODEL_NOT_CONFIGURED and MCP_CONNECTOR_NOT_REGISTERED diagnostic states accurately", async () => {
    const state = new ExtensionState();
    const logger = new MockLogger();

    const noModelClient = {
      sessions: { list: async () => ({ data: [] }) },
      agents: { list: async () => ({ data: [] }) },
      models: { list: async () => ({ data: [] }) },
      mcpServers: { list: async () => ({ data: [] }) },
    } as unknown as TrueForge;

    const connMgr = new ConnectionManager({ createClient: () => noModelClient }, state, logger);
    const res1 = await connMgr.checkConnection(baseConfig);
    assert.strictEqual(res1.diagnosticState, "MODEL_NOT_CONFIGURED");
    assert.strictEqual(res1.availableModels.length, 0);

    const noMcpClient = {
      sessions: { list: async () => ({ data: [] }) },
      agents: { list: async () => ({ data: [{ name: "patchpilot" }] }) },
      models: { list: async () => ({ data: [{ name: "openai/gpt-4o", modelId: "gpt-4o" }] }) },
      mcpServers: { list: async () => ({ data: [] }) },
    } as unknown as TrueForge;

    const connMgr2 = new ConnectionManager({ createClient: () => noMcpClient }, new ExtensionState(), logger);
    const res2 = await connMgr2.checkConnection(baseConfig);
    assert.strictEqual(res2.diagnosticState, "MCP_CONNECTOR_NOT_REGISTERED");
    assert.strictEqual(res2.availableModels.length, 1);
  });

  it("should handle tool.approval_required interactively via ApprovalManager and resume turn via subscribeToTurn", async () => {
    const state = new ExtensionState();
    const logger = new MockLogger();
    const submittedEvents: unknown[] = [];
    let subscribedAfterEventId: string | undefined;

    const firstStreamEvents = [
      { type: "turn.created", id: "ev-1", turnId: "turn-appr-1" },
      {
        type: "model.message",
        id: "ev-2",
        threadId: "main",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "propose_edit", arguments: '{"path":"src/a.py","content":"x=1"}' },
            toolInfo: { type: "mcp", name: "propose_edit", serverName: "patchpilot-workspace", serverId: "srv-1" },
          },
        ],
      },
      {
        type: "tool.approval_required",
        id: "ev-3",
        threadId: "main",
        toolCalls: [{ id: "call-1", sourceEventId: "ev-2" }],
      },
    ];

    const resumedStreamEvents = [
      { type: "tool.response", id: "ev-4", threadId: "main", toolCallId: "call-1", content: '{"proposalId":"prop-1"}' },
      { type: "model.message.delta", id: "ev-5", threadId: "main", content: "Proposed edit cleanly." },
      { type: "turn.done", id: "ev-6", state: { status: "done" } },
    ];

    async function* yieldEvents(items: unknown[]) {
      for (const item of items) {
        yield item;
      }
    }

    const mockClient = {
      sessions: {
        createTurnStream: async () => yieldEvents(firstStreamEvents),
        createTurnEvents: async (_sid: string, _tid: string, req: { events: unknown[] }) => {
          submittedEvents.push(...req.events);
          return { data: [] };
        },
        subscribeToTurn: async (_sid: string, _tid: string, req?: { afterEventId?: string }) => {
          subscribedAfterEventId = req?.afterEventId;
          return yieldEvents(resumedStreamEvents);
        },
        getTurn: async () => ({ data: { id: "turn-appr-1", state: { status: "done" } } }),
      },
    } as unknown as TrueForge;

    const factory: ITrueForgeClientFactory = { createClient: () => mockClient };
    const approvalMgr = new ApprovalManager(factory, logger);
    const streamMgr = new TurnStreamManager(factory, state, logger);

    const toolResponses: string[] = [];

    const result = await streamMgr.executeTurn(baseConfig, "sess-1", "Edit file", {
      approvalManager: approvalMgr,
      callbacks: {
        onApprovalRequired: (pending) => {
          assert.strictEqual(pending.length, 1);
          assert.strictEqual(pending[0].toolName, "propose_edit");
          // Simulate user clicking Approve in UI
          setTimeout(() => {
            void approvalMgr.submitDecision(baseConfig, pending[0].toolCallId, true);
          }, 20);
        },
        onToolResponse: (_callId, name, content) => {
          toolResponses.push(`${name}:${content}`);
        },
      },
    });

    assert.strictEqual(result.terminalStatus, "COMPLETED");
    assert.strictEqual(submittedEvents.length, 1);
    assert.strictEqual(subscribedAfterEventId, "ev-3");
    assert.strictEqual(toolResponses.length, 1);
    assert.ok(result.accumulatedText.includes("Proposed edit cleanly."));
  });

  it("should retry transient 503/network failures with backoff and NEVER retry 401 auth errors", async () => {
    assert.strictEqual(isRetryableTrueForgeError(Object.assign(new Error("Unauthorized"), { statusCode: 401 })), false);
    assert.strictEqual(isRetryableTrueForgeError(Object.assign(new Error("Rate limit"), { statusCode: 429 })), true);
    assert.strictEqual(isRetryableTrueForgeError(new Error("fetch failed: ECONNRESET")), true);

    const logger = new MockLogger();
    let attempts = 0;
    const flakyClient = {
      sessions: {
        createTurnStream: async () => {
          attempts++;
          if (attempts === 1) {
            throw Object.assign(new Error("503 Service Unavailable"), { statusCode: 503 });
          }
          return (async function* () {
            yield { type: "turn.created", id: "e1", turnId: "t-retry" };
            yield { type: "turn.done", id: "e2", state: { status: "done" } };
          })();
        },
        getTurn: async () => ({ data: { id: "t-retry", state: { status: "done" } } }),
      },
    } as unknown as TrueForge;

    const mgr = new TurnStreamManager({ createClient: () => flakyClient }, new ExtensionState(), logger);
    const res = await mgr.executeTurn(baseConfig, "sess-r", "Retry test", {
      maxRetries: 2,
      baseRetryDelayMs: 10,
    });
    assert.strictEqual(attempts, 2);
    assert.strictEqual(res.retriesPerformed, 1);
    assert.strictEqual(res.terminalStatus, "COMPLETED");

    // 401 must fail immediately on attempt 1 with 0 retries
    let authAttempts = 0;
    const authFailClient = {
      sessions: {
        createTurnStream: async () => {
          authAttempts++;
          throw Object.assign(new Error("401 Unauthorized: invalid API key"), { statusCode: 401 });
        },
      },
    } as unknown as TrueForge;

    const mgr2 = new TurnStreamManager({ createClient: () => authFailClient }, new ExtensionState(), logger);
    await assert.rejects(() =>
      mgr2.executeTurn(baseConfig, "sess-auth", "Auth fail", {
        maxRetries: 2,
        baseRetryDelayMs: 10,
      })
    );
    assert.strictEqual(authAttempts, 1, "Must NEVER retry 401 authentication errors");
  });

  it("should execute server-first cancellation, cancel local MCP subprocesses, and discard pending proposals", async () => {
    const state = new ExtensionState();
    state.setActiveSessionId("sess-c");
    state.setActiveTurn("turn-c", "RUNNING");
    const ctrl = new AbortController();
    state.setActiveAbortController(ctrl);

    const order: string[] = [];
    const mockClient = {
      sessions: {
        cancel: async () => {
          order.push("server-cancel");
          return { data: { cancelled: true } };
        },
        getTurn: async () => {
          order.push("get-turn");
          return { data: { id: "turn-c", state: { status: "cancelled" } } };
        },
      },
    } as unknown as TrueForge;

    const cancelMgr = new CancellationManager({ createClient: () => mockClient }, state, new MockLogger());
    const res = await cancelMgr.cancelActiveTurn(baseConfig, {
      runId: "run-1",
      cancelLocalMcp: async () => {
        order.push("local-mcp-cancel");
        return { abortedCommands: 1, discardedProposals: 2 };
      },
    });

    assert.strictEqual(order[0], "server-cancel");
    assert.ok(order.includes("local-mcp-cancel"));
    assert.strictEqual(res.authoritativeStatus, "cancelled");
    assert.strictEqual(res.abortedLocalCommands, 1);
    assert.strictEqual(res.discardedProposals, 2);
    assert.strictEqual(ctrl.signal.aborted, true);
  });
});
