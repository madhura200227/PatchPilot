import * as vscode from "vscode";
import { ConfigurationManager } from "../config/configuration";
import { ConnectionManager } from "../trueforge/connectionManager";
import { ILogger } from "../output/logger";

export function registerCheckConnectionCommand(
  context: vscode.ExtensionContext,
  configManager: ConfigurationManager,
  connectionManager: ConnectionManager,
  logger: ILogger
): vscode.Disposable {
  return vscode.commands.registerCommand("patchpilot.checkConnection", async () => {
    try {
      logger.show(true);
      const config = await configManager.getResolvedConfig();
      const result = await connectionManager.checkConnection(config);

      if (result.status === "CONNECTED") {
        if (!result.agentFound && config.agentName) {
          vscode.window.showWarningMessage(
            `Connected to TrueForge at ${result.serverUrl}, but agent '${config.agentName}' was not found. Available agents: [${result.availableAgents.join(", ")}].`
          );
        } else {
          vscode.window.showInformationMessage(
            `PatchPilot: Successfully connected to TrueForge server (${result.serverUrl}). Registered agents: ${result.agentCount}.`
          );
        }
      } else if (result.status === "AUTH_REQUIRED") {
        const action = await vscode.window.showErrorMessage(
          "PatchPilot: TrueForge server requires authentication.",
          "Set Access Token"
        );
        if (action === "Set Access Token") {
          vscode.commands.executeCommand("patchpilot.setToken");
        }
      } else {
        vscode.window.showErrorMessage(
          `PatchPilot: Could not connect to TrueForge server at ${result.serverUrl}. ${result.error || ""}`
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`PatchPilot connection check failed: ${msg}`);
    }
  });
}
