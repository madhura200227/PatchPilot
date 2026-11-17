import assert from "node:assert";
import { SessionManager } from "../../trueforge/sessionManager";
import { ExtensionState } from "../../state/extensionState";
import { MockLogger } from "../testHelpers";
import { ITrueForgeClientFactory } from "../../trueforge/clientFactory";
import { TrueForgeResolvedConfig } from "../../config/configuration";
import { TrueForgeConfigurationError } from "../../trueforge/errors";
import { TrueForge } from "@truefoundry/trueforge-sdk";

describe("Unit: SessionManager", () => {
  it("should create session with configured agent and save session ID to state", async () => {
    const state = new ExtensionState();
    const logger = new MockLogger();

    const mockClient = {
      sessions: {
        create: async (req: { agent: unknown }) => ({
          data: { id: "01m7session_created_123" },
        }),
      },
    } as unknown as TrueForge;

    const mockFactory: ITrueForgeClientFactory = {
      createClient: () => mockClient,
    };

    const manager = new SessionManager(mockFactory, state, logger);
    const config: TrueForgeResolvedConfig = {
      baseUrl: "http://localhost:8790",
      agentName: "patchpilot-agent",
      requestTimeoutSeconds: 30,
    };

    const sessionId = await manager.createSession(config);

    assert.strictEqual(sessionId, "01m7session_created_123");
    assert.strictEqual(state.activeSessionId, "01m7session_created_123");
  });

  it("should reuse active session when forceNew is false", async () => {
    const state = new ExtensionState();
    state.setActiveSessionId("existing-session-abc");
    const logger = new MockLogger();

    let createCalled = false;
    const mockClient = {
      sessions: {
        create: async () => {
          createCalled = true;
          return { data: { id: "new-session" } };
        },
      },
    } as unknown as TrueForge;

    const mockFactory: ITrueForgeClientFactory = {
      createClient: () => mockClient,
    };

    const manager = new SessionManager(mockFactory, state, logger);
    const config: TrueForgeResolvedConfig = {
      baseUrl: "http://localhost:8790",
      agentName: "patchpilot-agent",
      requestTimeoutSeconds: 30,
    };

    const sessionId = await manager.createSession(config, { forceNew: false });

    assert.strictEqual(sessionId, "existing-session-abc");
    assert.strictEqual(createCalled, false, "Should not call create when existing session is active");
  });

  it("should create a new session when forceNew is true", async () => {
    const state = new ExtensionState();
    state.setActiveSessionId("old-session-abc");
    const logger = new MockLogger();

    const mockClient = {
      sessions: {
        create: async () => ({ data: { id: "brand-new-session" } }),
      },
    } as unknown as TrueForge;

    const mockFactory: ITrueForgeClientFactory = {
      createClient: () => mockClient,
    };

    const manager = new SessionManager(mockFactory, state, logger);
    const config: TrueForgeResolvedConfig = {
      baseUrl: "http://localhost:8790",
      agentName: "patchpilot-agent",
      requestTimeoutSeconds: 30,
    };

    const sessionId = await manager.createSession(config, { forceNew: true });

    assert.strictEqual(sessionId, "brand-new-session");
    assert.strictEqual(state.activeSessionId, "brand-new-session");
  });

  it("should throw TrueForgeConfigurationError when agentName is not configured", async () => {
    const state = new ExtensionState();
    const logger = new MockLogger();

    const mockClient = {} as unknown as TrueForge;
    const mockFactory: ITrueForgeClientFactory = {
      createClient: () => mockClient,
    };

    const manager = new SessionManager(mockFactory, state, logger);
    const config: TrueForgeResolvedConfig = {
      baseUrl: "http://localhost:8790",
      agentName: "", // Empty agent name
      requestTimeoutSeconds: 30,
    };

    await assert.rejects(
      async () => {
        await manager.createSession(config);
      },
      (err: unknown) => {
        assert.ok(err instanceof TrueForgeConfigurationError);
        assert.ok((err as TrueForgeConfigurationError).message.includes("TrueForge agent is not configured"));
        return true;
      }
    );
  });

  it("should delete session and clear state", async () => {
    const state = new ExtensionState();
    state.setActiveSessionId("session-to-delete");
    const logger = new MockLogger();

    let deletedId = "";
    const mockClient = {
      sessions: {
        delete: async (id: string) => {
          deletedId = id;
        },
      },
    } as unknown as TrueForge;

    const mockFactory: ITrueForgeClientFactory = {
      createClient: () => mockClient,
    };

    const manager = new SessionManager(mockFactory, state, logger);
    const config: TrueForgeResolvedConfig = {
      baseUrl: "http://localhost:8790",
      agentName: "patchpilot-agent",
      requestTimeoutSeconds: 30,
    };

    await manager.deleteSession(config, "session-to-delete");

    assert.strictEqual(deletedId, "session-to-delete");
    assert.strictEqual(state.activeSessionId, undefined);
  });
});
