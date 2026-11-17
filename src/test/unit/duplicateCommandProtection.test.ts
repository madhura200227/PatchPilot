import assert from "node:assert";
import { ExtensionState } from "../../state/extensionState";

describe("Unit: Concurrency Guards & Duplicate Command Protection", () => {
  it("should guard against duplicate session creation", () => {
    const state = new ExtensionState();

    assert.strictEqual(state.acquireStartSessionGuard(), true);
    // Second concurrent call must be rejected
    assert.strictEqual(state.acquireStartSessionGuard(), false);

    state.releaseStartSessionGuard();
    assert.strictEqual(state.acquireStartSessionGuard(), true);
    state.releaseStartSessionGuard();
  });

  it("should guard against duplicate turn submission while turn is already running", () => {
    const state = new ExtensionState();

    assert.strictEqual(state.acquireSendMessageGuard(), true);
    // Concurrent send message call rejected
    assert.strictEqual(state.acquireSendMessageGuard(), false);

    state.releaseSendMessageGuard();
    // If state is RUNNING, acquireSendMessageGuard must also reject
    state.setActiveTurn("turn-123", "RUNNING");
    assert.strictEqual(state.acquireSendMessageGuard(), false);

    state.setTurnStatus("COMPLETED");
    assert.strictEqual(state.acquireSendMessageGuard(), true);
    state.releaseSendMessageGuard();
  });

  it("should guard against concurrent cancellations", () => {
    const state = new ExtensionState();

    assert.strictEqual(state.acquireCancelGuard(), true);
    assert.strictEqual(state.acquireCancelGuard(), false);

    state.releaseCancelGuard();
    assert.strictEqual(state.acquireCancelGuard(), true);
    state.releaseCancelGuard();
  });

  it("should generate appropriate status bar text for all extension states", () => {
    const state = new ExtensionState();

    assert.ok(state.getStatusBarText().includes("Not configured"));

    state.setConnectionStatus("CONNECTING");
    assert.ok(state.getStatusBarText().includes("Connecting"));

    state.setConnectionStatus("CONNECTED");
    assert.ok(state.getStatusBarText().includes("Connected"));

    state.setActiveSessionId("session-001");
    assert.ok(state.getStatusBarText().includes("Session active"));

    state.setActiveTurn("turn-001", "RUNNING");
    assert.ok(state.getStatusBarText().includes("Turn running"));

    state.setTurnStatus("PAUSED");
    assert.ok(state.getStatusBarText().includes("Turn paused"));

    state.setTurnStatus("COMPLETED");
    assert.ok(state.getStatusBarText().includes("Turn completed"));

    state.setTurnStatus("CANCELLED");
    assert.ok(state.getStatusBarText().includes("Turn cancelled"));

    state.setTurnStatus("ERROR");
    assert.ok(state.getStatusBarText().includes("Turn error"));

    state.setConnectionStatus("CONNECTION_FAILED");
    state.setTurnStatus("IDLE");
    assert.ok(state.getStatusBarText().includes("Connection failed"));

    state.setConnectionStatus("AUTH_REQUIRED");
    assert.ok(state.getStatusBarText().includes("Authentication required"));
  });
});
