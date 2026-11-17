import * as vscode from "vscode";
import { ConfigurationManager } from "../config/configuration";
import { SessionManager } from "../trueforge/sessionManager";
import { ILogger } from "../output/logger";

export function registerStartSessionCommand(
  context: vscode.ExtensionContext,
  configManager: ConfigurationManager,
  sessionManager: SessionManager,
  logger: ILogger
): vscode.Disposable {
  return vscode.commands.registerCommand("patchpilot.startSession", async () => {
    try {
      logger.show(true);
      const config = await configManager.getResolvedConfig();

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

      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "PatchPilot: Creating TrueForge session...",
          cancellable: false,
        },
        async () => {
          const sessionId = await sessionManager.createSession(config);
          vscode.window.showInformationMessage(
            `PatchPilot: Active session established! ID: ${sessionId}`
          );
        }
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`PatchPilot: Failed to start session: ${msg}`);
    }
  });
}
