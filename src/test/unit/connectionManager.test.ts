import assert from "node:assert";
import { ConnectionManager } from "../../trueforge/connectionManager";
import { ExtensionState } from "../../state/extensionState";
import { MockLogger } from "../testHelpers";
import { ITrueForgeClientFactory } from "../../trueforge/clientFactory";
import { TrueForgeResolvedConfig } from "../../config/configuration";
import { TrueForge } from "@truefoundry/trueforge-sdk";

describe("Unit: ConnectionManager", () => {
  it("should transition to CONNECTED on successful health and agent listing", async () => {
    const state = new ExtensionState();
    const logger = new MockLogger();

    const mockClient = {
      sessions: {
        list: async () => ({ data: [], pagination: {} }),
      },
      agents: {
        list: async () => ({ data: [{ name: "patchpilot-agent" }], pagination: {} }),
      },
    } as unknown as TrueForge;

    const mockFactory: ITrueForgeClientFactory = {
      createClient: () => mockClient,
    };

    const manager = new ConnectionManager(mockFactory, state, logger);
    const config: TrueForgeResolvedConfig = {
      baseUrl: "http://localhost:8790",
      agentName: "patchpilot-agent",
      requestTimeoutSeconds: 30,
    };

    const result = await manager.checkConnection(config);

    assert.strictEqual(result.status, "CONNECTED");
    assert.strictEqual(state.connectionStatus, "CONNECTED");
    assert.strictEqual(result.agentFound, true);
    assert.strictEqual(result.agentCount, 1);
  });

  it("should detect when configured agent is missing from registered agents", async () => {
    const state = new ExtensionState();
    const logger = new MockLogger();

    const mockClient = {
      sessions: {
        list: async () => ({ data: [], pagination: {} }),
      },
      agents: {
        list: async () => ({ data: [{ name: "other-agent" }], pagination: {} }),
      },
    } as unknown as TrueForge;

    const mockFactory: ITrueForgeClientFactory = {
      createClient: () => mockClient,
    };

    const manager = new ConnectionManager(mockFactory, state, logger);
    const config: TrueForgeResolvedConfig = {
      baseUrl: "http://localhost:8790",
      agentName: "non-existent-agent",
      requestTimeoutSeconds: 30,
    };

    const result = await manager.checkConnection(config);

    assert.strictEqual(result.status, "CONNECTED");
    assert.strictEqual(result.agentFound, false);
    assert.ok(result.message.includes("not found on server"));
  });

  it("should transition to AUTH_REQUIRED when server returns 401 Unauthorized", async () => {
    const state = new ExtensionState();
    const logger = new MockLogger();

    const mockClient = {
      sessions: {
        list: async () => {
          const err = new Error("Unauthorized: Invalid bearer token");
          (err as { statusCode?: number }).statusCode = 401;
          throw err;
        },
      },
    } as unknown as TrueForge;

    const mockFactory: ITrueForgeClientFactory = {
      createClient: () => mockClient,
    };

    const manager = new ConnectionManager(mockFactory, state, logger);
    const config: TrueForgeResolvedConfig = {
      baseUrl: "http://localhost:8790",
      agentName: "agent-1",
      requestTimeoutSeconds: 30,
    };

    const result = await manager.checkConnection(config);

    assert.strictEqual(result.status, "AUTH_REQUIRED");
    assert.strictEqual(state.connectionStatus, "AUTH_REQUIRED");
    assert.ok(result.message.includes("authentication"));
  });

  it("should transition to CONNECTION_FAILED on network or connection timeout", async () => {
    const state = new ExtensionState();
    const logger = new MockLogger();

    const mockClient = {
      sessions: {
        list: async () => {
          throw new Error("connect ECONNREFUSED 127.0.0.1:8790");
        },
      },
    } as unknown as TrueForge;

    const mockFactory: ITrueForgeClientFactory = {
      createClient: () => mockClient,
    };

    const manager = new ConnectionManager(mockFactory, state, logger);
    const config: TrueForgeResolvedConfig = {
      baseUrl: "http://localhost:8790",
      agentName: "agent-1",
      requestTimeoutSeconds: 30,
    };

    const result = await manager.checkConnection(config);

    assert.strictEqual(result.status, "CONNECTION_FAILED");
    assert.strictEqual(state.connectionStatus, "CONNECTION_FAILED");
    assert.ok(result.message.includes("Failed to connect"));
  });
});
