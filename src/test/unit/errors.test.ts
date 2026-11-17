import assert from "node:assert";
import {
  PatchPilotError,
  TrueForgeConnectionError,
  TrueForgeAuthError,
  TrueForgeConfigurationError,
  TrueForgeSessionError,
  TrueForgeStreamError,
  TrueForgeCancellationError,
  TrueForgeTurnError,
  TrueForgeUnsupportedEventError,
} from "../../trueforge/errors";

describe("Unit: Domain Errors", () => {
  it("should construct TrueForgeConnectionError with server URL", () => {
    const err = new TrueForgeConnectionError("Connection failed", "http://localhost:8790");
    assert.ok(err instanceof PatchPilotError);
    assert.strictEqual(err.name, "TrueForgeConnectionError");
    assert.strictEqual(err.serverUrl, "http://localhost:8790");
  });

  it("should construct TrueForgeAuthError with status code", () => {
    const err = new TrueForgeAuthError("Unauthorized", "http://localhost:8790", 401);
    assert.ok(err instanceof PatchPilotError);
    assert.strictEqual(err.name, "TrueForgeAuthError");
    assert.strictEqual(err.statusCode, 401);
  });

  it("should construct TrueForgeConfigurationError with configKey", () => {
    const err = new TrueForgeConfigurationError("Agent required", "patchpilot.trueforge.agentName");
    assert.ok(err instanceof PatchPilotError);
    assert.strictEqual(err.configKey, "patchpilot.trueforge.agentName");
  });

  it("should construct TrueForgeUnsupportedEventError with event details", () => {
    const err = new TrueForgeUnsupportedEventError("tool.approval_required");
    assert.ok(err instanceof PatchPilotError);
    assert.strictEqual(err.eventType, "tool.approval_required");
    assert.ok(err.message.includes("Milestone 0"));
  });
});
