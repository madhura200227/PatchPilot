import assert from "node:assert";
import { TurnStreamManager } from "../../trueforge/turnStream";
import { ExtensionState } from "../../state/extensionState";
import { MockLogger } from "../testHelpers";
import { ITrueForgeClientFactory } from "../../trueforge/clientFactory";
import { TrueForgeResolvedConfig } from "../../config/configuration";
import { TrueForge } from "@truefoundry/trueforge-sdk";

describe("Unit: TurnStreamManager & Delta Aggregation", () => {
  it("should stream message deltas incrementally and avoid duplicate text", async () => {
    const state = new ExtensionState();
    const logger = new MockLogger();

    const mockEvents = [
      { type: "turn.created", id: "evt-01", turnId: "turn-abc" },
      { type: "model.message.delta", id: "evt-02", content: "Hello " },
      { type: "model.message.delta", id: "evt-03", content: "from " },
      { type: "model.message.delta", id: "evt-04", content: "TrueForge!" },
      { type: "model.message", id: "evt-05", content: "Hello from TrueForge!" }, // Full message must not duplicate
      { type: "turn.done", id: "evt-06", state: { status: "done" } },
    ];

    async function* createAsyncStream() {
      for (const ev of mockEvents) {
        yield ev;
      }
    }

    const mockClient = {
      sessions: {
        createTurnStream: async () => createAsyncStream(),
        getTurn: async () => ({ data: { id: "turn-abc", state: { status: "done" } } }),
      },
    } as unknown as TrueForge;

    const mockFactory: ITrueForgeClientFactory = {
      createClient: () => mockClient,
    };

    const manager = new TurnStreamManager(mockFactory, state, logger);
    const config: TrueForgeResolvedConfig = {
      baseUrl: "http://localhost:8790",
      agentName: "patchpilot-agent",
      requestTimeoutSeconds: 30,
    };

    const result = await manager.executeTurn(config, "sess-01", "Hello test");

    assert.strictEqual(result.turnId, "turn-abc");
    assert.strictEqual(result.terminalStatus, "COMPLETED");
    assert.strictEqual(result.accumulatedText, "Hello from TrueForge!");
    assert.strictEqual(state.turnAccumulatedText, "Hello from TrueForge!");
    // Ensure streamedChunks contains each delta chunk
    assert.deepStrictEqual(logger.streamedChunks.slice(0, 3), ["Hello ", "from ", "TrueForge!"]);
    // Ensure full model.message was not appended a second time
    assert.strictEqual(result.accumulatedText.split("Hello").length - 1, 1);
  });

  it("should record terminal error status when turn.done reports error", async () => {
    const state = new ExtensionState();
    const logger = new MockLogger();

    const mockEvents = [
      { type: "turn.created", id: "evt-01", turnId: "turn-error-1" },
      { type: "turn.done", id: "evt-02", state: { status: "error", message: "Model key invalid" } },
    ];

    async function* createAsyncStream() {
      for (const ev of mockEvents) {
        yield ev;
      }
    }

    const mockClient = {
      sessions: {
        createTurnStream: async () => createAsyncStream(),
        getTurn: async () => ({ data: { id: "turn-error-1", state: { status: "error" } } }),
      },
    } as unknown as TrueForge;

    const mockFactory: ITrueForgeClientFactory = {
      createClient: () => mockClient,
    };

    const manager = new TurnStreamManager(mockFactory, state, logger);
    const config: TrueForgeResolvedConfig = {
      baseUrl: "http://localhost:8790",
      agentName: "patchpilot-agent",
      requestTimeoutSeconds: 30,
    };

    const result = await manager.executeTurn(config, "sess-01", "Hello error");

    assert.strictEqual(result.terminalStatus, "ERROR");
    assert.strictEqual(state.turnStatus, "ERROR");
  });

  it("should handle turn recovery without resubmitting prompt", async () => {
    const state = new ExtensionState();
    state.appendTurnText("Prior partial text. ");
    const logger = new MockLogger();

    // Mock recovery: authoritative state shows "done"
    const mockClient = {
      sessions: {
        getTurn: async () => ({
          data: {
            id: "turn-recovering",
            state: { status: "done" },
          },
        }),
      },
    } as unknown as TrueForge;

    const mockFactory: ITrueForgeClientFactory = {
      createClient: () => mockClient,
    };

    const manager = new TurnStreamManager(mockFactory, state, logger);
    const config: TrueForgeResolvedConfig = {
      baseUrl: "http://localhost:8790",
      agentName: "patchpilot-agent",
      requestTimeoutSeconds: 30,
    };

    const result = await manager.recoverTurn(config, "sess-01", "turn-recovering");

    assert.strictEqual(result.terminalStatus, "COMPLETED");
    assert.strictEqual(state.turnStatus, "COMPLETED");
    assert.strictEqual(result.accumulatedText, "Prior partial text. ");
  });
});
