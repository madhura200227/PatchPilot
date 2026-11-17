import * as vscode from "vscode";
import { ConfigurationManager } from "../config/configuration";
import { CancellationManager } from "../trueforge/cancellationManager";
import { ILogger } from "../output/logger";

export function registerCancelTurnCommand(
  context: vscode.ExtensionContext,
  configManager: ConfigurationManager,
  cancellationManager: CancellationManager,
  logger: ILogger
): vscode.Disposable {
  return vscode.commands.registerCommand("patchpilot.cancelTurn", async () => {
    try {
      const config = await configManager.getResolvedConfig();
      logger.info("Executing cancellation command...");

      const result = await cancellationManager.cancelActiveTurn(config);

      if (result.serverAccepted || result.clientAborted) {
        vscode.window.showInformationMessage(
          `PatchPilot: Active turn cancellation processed (Status: ${result.authoritativeStatus || "cancelled"}).`
        );
      } else {
        vscode.window.showWarningMessage(
          `PatchPilot: Cancellation completed. ${result.message}`
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`PatchPilot cancellation error: ${msg}`);
    }
  });
}
