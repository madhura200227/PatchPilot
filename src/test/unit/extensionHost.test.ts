import assert from "node:assert";
import * as vscode from "vscode";
import { activate, deactivate } from "../../extension";
import { createMockExtensionContext, MockSecretStorage } from "../testHelpers";

describe("Extension Host Lifecycle & Command Registration", () => {
  it("should activate extension cleanly, register all commands, and initialize state", async () => {
    const mockContext = createMockExtensionContext();

    const result = activate(mockContext);

    assert.ok(result, "Extension activation must return managers and state");
    assert.ok(result.state, "State machine must be initialized");
    assert.ok(result.logger, "Logger must be initialized");
    assert.ok(result.connectionManager, "ConnectionManager must be initialized");
    assert.ok(result.sessionManager, "SessionManager must be initialized");
    assert.ok(result.turnStreamManager, "TurnStreamManager must be initialized");
    assert.ok(result.cancellationManager, "CancellationManager must be initialized");

    // Check subscriptions in context
    assert.ok(mockContext.subscriptions.length >= 7, "All commands and listeners must be registered in subscriptions");

    // Verify commands exist in VS Code registry
    const registeredCommands = await vscode.commands.getCommands(true);
    const expectedCommands = [
      "patchpilot.checkConnection",
      "patchpilot.startSession",
      "patchpilot.sendTestMessage",
      "patchpilot.cancelTurn",
      "patchpilot.showOutput",
      "patchpilot.setToken",
      "patchpilot.clearToken",
    ];

    for (const cmd of expectedCommands) {
      assert.ok(
        registeredCommands.includes(cmd),
        `Command '${cmd}' must be registered in VS Code extension host`
      );
    }
  });

  it("should deactivate cleanly without throwing", () => {
    assert.doesNotThrow(() => {
      deactivate();
    }, "Extension deactivation must execute cleanly");
  });
});
