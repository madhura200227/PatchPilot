import assert from "node:assert";
import * as vscode from "vscode";
import { activate, deactivate } from "../../extension";
import { createMockExtensionContext } from "../testHelpers";

describe("Extension Host Lifecycle & Command Registration", () => {
  it("should activate extension cleanly, register all MVP and legacy commands, and initialize state", async () => {
    const mockContext = createMockExtensionContext();

    const result = activate(mockContext);

    assert.ok(result, "Extension activation must return managers and state");
    assert.ok(result.state, "State machine must be initialized");
    assert.ok(result.logger, "Logger must be initialized");
    assert.ok(result.connectionManager, "ConnectionManager must be initialized");
    assert.ok(result.sessionManager, "SessionManager must be initialized");
    assert.ok(result.turnStreamManager, "TurnStreamManager must be initialized");
    assert.ok(result.cancellationManager, "CancellationManager must be initialized");
    assert.ok(result.controller, "PatchPilotController must be initialized");
    assert.ok(result.agentViewProvider, "AgentViewProvider must be initialized");
    assert.ok(result.reviewPanelProvider, "ReviewPanelProvider must be initialized");

    assert.ok(mockContext.subscriptions.length >= 20, "All commands, views, and listeners must be registered");

    const registeredCommands = await vscode.commands.getCommands(true);
    const expectedCommands = [
      // MVP required commands
      "patchpilot.openAgent",
      "patchpilot.inlineEdit",
      "patchpilot.startAgentRun",
      "patchpilot.cancelRun",
      "patchpilot.reviewChanges",
      "patchpilot.applyAcceptedChanges",
      "patchpilot.discardChanges",
      "patchpilot.undoLastApply",
      "patchpilot.checkTrueForge",
      "patchpilot.configureTrueForge",
      "patchpilot.showSession",
      "patchpilot.selectWorkspace",
      // Legacy M0 commands
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

  it("should deactivate cleanly without throwing", async () => {
    await deactivate();
  });
});
