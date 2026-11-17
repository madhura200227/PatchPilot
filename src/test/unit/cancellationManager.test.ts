import assert from "node:assert";
import { CancellationManager } from "../../trueforge/cancellationManager";
import { ExtensionState } from "../../state/extensionState";
import { MockLogger } from "../testHelpers";
import { ITrueForgeClientFactory } from "../../trueforge/clientFactory";
import { TrueForgeResolvedConfig } from "../../config/configuration";
import { TrueForge } from "@truefoundry/trueforge-sdk";

describe("Unit: CancellationManager (Layers A & B)", () => {
  it("should trigger client AbortController and dispatch server-side cancel", async () => {
    const state = new ExtensionState();
    state.setActiveSessionId("sess-to-cancel");
    state.setActiveTurn("turn-to-cancel", "RUNNING");

    const abortController = new AbortController();
    state.setActiveAbortController(abortController);

    const logger = new MockLogger();
    let serverCancelCalledWith = "";

    const mockClient = {
      sessions: {
        cancel: async (sessionId: string) => {
          serverCancelCalledWith = sessionId;
          return { data: { cancelled: true } };
        },
        getTurn: async () => ({
          data: {
            id: "turn-to-cancel",
            state: { status: "cancelled" },
          },
        }),
      },
    } as unknown as TrueForge;

    const mockFactory: ITrueForgeClientFactory = {
      createClient: () => mockClient,
    };

    const manager = new CancellationManager(mockFactory, state, logger);
    const config: TrueForgeResolvedConfig = {
      baseUrl: "http://localhost:8790",
      agentName: "patchpilot-agent",
      requestTimeoutSeconds: 30,
    };

    const result = await manager.cancelActiveTurn(config);

    assert.strictEqual(abortController.signal.aborted, true, "Layer A: AbortSignal must be aborted");
    assert.strictEqual(result.clientAborted, true);
    assert.strictEqual(serverCancelCalledWith, "sess-to-cancel", "Layer B: Server cancel must be called");
    assert.strictEqual(result.serverAccepted, true);
    assert.strictEqual(result.authoritativeStatus, "cancelled");
    assert.strictEqual(state.turnStatus, "CANCELLED");
  });

  it("should handle already-completed or idle turn gracefully (412 PreconditionFailed)", async () => {
    const state = new ExtensionState();
    state.setActiveSessionId("sess-already-done");
    state.setActiveTurn("turn-done-1", "RUNNING");
    const logger = new MockLogger();

    const mockClient = {
      sessions: {
        cancel: async () => {
          throw new Error("PreconditionFailedError: no running turn to cancel");
        },
        getTurn: async () => ({
          data: {
            id: "turn-done-1",
            state: { status: "done" },
          },
        }),
      },
    } as unknown as TrueForge;

    const mockFactory: ITrueForgeClientFactory = {
      createClient: () => mockClient,
    };

    const manager = new CancellationManager(mockFactory, state, logger);
    const config: TrueForgeResolvedConfig = {
      baseUrl: "http://localhost:8790",
      agentName: "patchpilot-agent",
      requestTimeoutSeconds: 30,
    };

    const result = await manager.cancelActiveTurn(config);

    assert.strictEqual(result.serverAccepted, true, "Endpoint handled gracefully as functional response");
    assert.strictEqual(result.authoritativeStatus, "done");
    assert.strictEqual(state.turnStatus, "COMPLETED");
  });

  it("should return early when no active session exists", async () => {
    const state = new ExtensionState();
    const logger = new MockLogger();

    const mockClient = {} as unknown as TrueForge;
    const mockFactory: ITrueForgeClientFactory = {
      createClient: () => mockClient,
    };

    const manager = new CancellationManager(mockFactory, state, logger);
    const config: TrueForgeResolvedConfig = {
      baseUrl: "http://localhost:8790",
      agentName: "patchpilot-agent",
      requestTimeoutSeconds: 30,
    };

    const result = await manager.cancelActiveTurn(config);
    assert.strictEqual(result.clientAborted, false);
    assert.strictEqual(result.serverAccepted, false);
    assert.ok(result.message.includes("No active session"));
  });
});
