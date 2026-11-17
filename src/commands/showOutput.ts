import * as vscode from "vscode";
import { ILogger } from "../output/logger";

export function registerShowOutputCommand(logger: ILogger): vscode.Disposable {
  return vscode.commands.registerCommand("patchpilot.showOutput", () => {
    logger.show(false);
  });
}
