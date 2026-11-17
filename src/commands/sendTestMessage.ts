import * as vscode from "vscode";
import { ConfigurationManager } from "../config/configuration";
import { SessionManager } from "../trueforge/sessionManager";
import { TurnStreamManager } from "../trueforge/turnStream";
import { ILogger } from "../output/logger";

export function registerSendTestMessageCommand(
  context: vscode.ExtensionContext,
  configManager: ConfigurationManager,
  sessionManager: SessionManager,
  turnStreamManager: TurnStreamManager,
  logger: ILogger
): vscode.Disposable {
  return vscode.commands.registerCommand("patchpilot.sendTestMessage", async () => {
    try {
      const config = await configManager.getResolvedConfig();

      // Check agent configuration
      if (!config.agentName) {
        const action = await vscode.window.showErrorMessage(
          "PatchPilot: TrueForge agent name is not configured. Please configure 'patchpilot.trueforge.agentName' in settings.",
          "Open Settings"
        );
        if (action === "Open Settings") {
          vscode.commands.executeCommand("workbench.action.openSettings", "patchpilot.trueforge");
        }
        return;
      }

      // Prompt user for test message
      const userInput = await vscode.window.showInputBox({
        title: "PatchPilot: Send Test Message to TrueForge",
        prompt: "Enter test prompt for the configured TrueForge agent",
        placeHolder: "e.g. Please respond with a short confirmation message.",
        ignoreFocusOut: true,
      });

      if (!userInput || userInput.trim().length === 0) {
        return;
      }

      logger.show(true);

      // Ensure session exists
      let sessionId = sessionManager.getActiveSessionId();
      if (!sessionId) {
        logger.info("No active session found. Creating a new session...");
        sessionId = await sessionManager.createSession(config);
      }

      // Run turn with progress notification
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "PatchPilot: Executing TrueForge turn...",
          cancellable: true,
        },
        async (progress, token) => {
          token.onCancellationRequested(() => {
            vscode.commands.executeCommand("patchpilot.cancelTurn");
          });

          const result = await turnStreamManager.executeTurn(
            config,
            sessionId!,
            userInput.trim()
          );

          if (result.terminalStatus === "COMPLETED") {
            vscode.window.showInformationMessage(
              `PatchPilot: Turn completed successfully! (${result.eventsCount} events received)`
            );
          } else if (result.terminalStatus === "CANCELLED") {
            vscode.window.showWarningMessage("PatchPilot: Turn was cancelled.");
          } else if (result.terminalStatus === "PAUSED") {
            vscode.window.showWarningMessage(
              "PatchPilot: Turn is paused awaiting approval or tool input (unsupported in Milestone 0)."
            );
          } else {
            vscode.window.showErrorMessage(
              `PatchPilot: Turn ended in status '${result.terminalStatus}'. ${result.error || ""}`
            );
          }
        }
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`PatchPilot turn execution error: ${msg}`);
    }
  });
}
