import * as vscode from "vscode";
import { ConfigurationManager } from "../config/configuration";
import { ILogger } from "../output/logger";

export function registerTokenCommands(
  configManager: ConfigurationManager,
  logger: ILogger
): vscode.Disposable[] {
  const setToken = vscode.commands.registerCommand("patchpilot.setToken", async () => {
    const token = await vscode.window.showInputBox({
      title: "PatchPilot: Set TrueForge Access Token",
      prompt: "Enter TrueForge Bearer token (stored securely in VS Code SecretStorage)",
      password: true,
      ignoreFocusOut: true,
    });

    if (token === undefined) {
      return; // Cancelled
    }

    if (token.trim().length === 0) {
      await configManager.clearApiToken();
      logger.info("TrueForge access token cleared from SecretStorage.");
      vscode.window.showInformationMessage("PatchPilot: TrueForge access token cleared.");
      return;
    }

    await configManager.setApiToken(token);
    logger.info("TrueForge access token securely stored in SecretStorage.");
    vscode.window.showInformationMessage("PatchPilot: TrueForge access token saved securely.");
  });

  const clearToken = vscode.commands.registerCommand("patchpilot.clearToken", async () => {
    await configManager.clearApiToken();
    logger.info("TrueForge access token cleared from SecretStorage.");
    vscode.window.showInformationMessage("PatchPilot: TrueForge access token cleared.");
  });

  return [setToken, clearToken];
}
