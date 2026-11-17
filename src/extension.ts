import * as vscode from "vscode";
import { PatchPilotLogger, ILogger } from "./output/logger";
import { ExtensionState } from "./state/extensionState";
import { ConfigurationManager } from "./config/configuration";
import { TrueForgeClientFactory } from "./trueforge/clientFactory";
import { ConnectionManager } from "./trueforge/connectionManager";
import { SessionManager } from "./trueforge/sessionManager";
import { TurnStreamManager } from "./trueforge/turnStream";
import { CancellationManager } from "./trueforge/cancellationManager";

import { registerCheckConnectionCommand } from "./commands/checkConnection";
import { registerStartSessionCommand } from "./commands/startSession";
import { registerSendTestMessageCommand } from "./commands/sendTestMessage";
import { registerCancelTurnCommand } from "./commands/cancelTurn";
import { registerShowOutputCommand } from "./commands/showOutput";
import { registerTokenCommands } from "./commands/tokenCommands";

let globalLogger: ILogger | undefined;
let globalState: ExtensionState | undefined;

export function activate(context: vscode.ExtensionContext): {
  state: ExtensionState;
  logger: ILogger;
  connectionManager: ConnectionManager;
  sessionManager: SessionManager;
  turnStreamManager: TurnStreamManager;
  cancellationManager: CancellationManager;
} {
  const logger = new PatchPilotLogger();
  globalLogger = logger;
  logger.info("Initializing PatchPilot extension (Milestone 0)...");

  const state = new ExtensionState();
  globalState = state;

  const configManager = new ConfigurationManager(context.secrets);
  const clientFactory = new TrueForgeClientFactory();

  const connectionManager = new ConnectionManager(clientFactory, state, logger);
  const sessionManager = new SessionManager(clientFactory, state, logger);
  const turnStreamManager = new TurnStreamManager(clientFactory, state, logger);
  const cancellationManager = new CancellationManager(clientFactory, state, logger);

  // Status bar item setup
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = "patchpilot.showOutput";
  statusBarItem.text = state.getStatusBarText();
  statusBarItem.tooltip = "PatchPilot TrueForge Bridge Status";
  statusBarItem.show();

  const stateListener = state.onDidChange(() => {
    statusBarItem.text = state.getStatusBarText();
  });

  // Register commands
  const checkConnCmd = registerCheckConnectionCommand(context, configManager, connectionManager, logger);
  const startSessionCmd = registerStartSessionCommand(context, configManager, sessionManager, logger);
  const sendTestMsgCmd = registerSendTestMessageCommand(context, configManager, sessionManager, turnStreamManager, logger);
  const cancelTurnCmd = registerCancelTurnCommand(context, configManager, cancellationManager, logger);
  const showOutputCmd = registerShowOutputCommand(logger);
  const tokenCmds = registerTokenCommands(configManager, logger);

  context.subscriptions.push(
    statusBarItem,
    stateListener,
    checkConnCmd,
    startSessionCmd,
    sendTestMsgCmd,
    cancelTurnCmd,
    showOutputCmd,
    ...tokenCmds
  );

  logger.info("PatchPilot extension successfully activated. Commands registered.");

  return {
    state,
    logger,
    connectionManager,
    sessionManager,
    turnStreamManager,
    cancellationManager,
  };
}

export function deactivate(): void {
  if (globalLogger) {
    globalLogger.info("PatchPilot extension deactivating...");
    globalLogger.dispose();
    globalLogger = undefined;
  }
  if (globalState) {
    globalState.dispose();
    globalState = undefined;
  }
}
