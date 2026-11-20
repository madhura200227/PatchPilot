import * as vscode from "vscode";
import { registerCancelTurnCommand } from "./commands/cancelTurn";
import { registerCheckConnectionCommand } from "./commands/checkConnection";
import { registerMvpCommands } from "./commands/mvpCommands";
import { registerSendTestMessageCommand } from "./commands/sendTestMessage";
import { registerShowOutputCommand } from "./commands/showOutput";
import { registerStartSessionCommand } from "./commands/startSession";
import { registerTokenCommands } from "./commands/tokenCommands";
import { ConfigurationManager } from "./config/configuration";
import { PatchPilotController } from "./controller/PatchPilotController";
import { ILogger, PatchPilotLogger } from "./output/logger";
import { ExtensionState } from "./state/extensionState";
import { CancellationManager } from "./trueforge/cancellationManager";
import { TrueForgeClientFactory } from "./trueforge/clientFactory";
import { ConnectionManager } from "./trueforge/connectionManager";
import { SessionManager } from "./trueforge/sessionManager";
import { TurnStreamManager } from "./trueforge/turnStream";
import { AGENT_VIEW_ID, AgentViewProvider } from "./ui/AgentViewProvider";
import {
  PATCHPILOT_PROPOSAL_SCHEME,
  ProposalDiffContentProvider,
} from "./ui/ProposalDiffContentProvider";
import { ReviewPanelProvider } from "./ui/ReviewPanelProvider";

let globalLogger: ILogger | undefined;
let globalState: ExtensionState | undefined;
let globalController: PatchPilotController | undefined;

export interface PatchPilotExtensionApi {
  state: ExtensionState;
  logger: ILogger;
  connectionManager: ConnectionManager;
  sessionManager: SessionManager;
  turnStreamManager: TurnStreamManager;
  cancellationManager: CancellationManager;
  controller: PatchPilotController;
  agentViewProvider: AgentViewProvider;
  reviewPanelProvider: ReviewPanelProvider;
}

export function activate(context: vscode.ExtensionContext): PatchPilotExtensionApi {
  const logger = new PatchPilotLogger();
  globalLogger = logger;
  logger.info("Initializing PatchPilot VS Code Coding Agent (TrueForge MVP)...");

  const state = new ExtensionState();
  globalState = state;

  const configManager = new ConfigurationManager(context.secrets);
  const clientFactory = new TrueForgeClientFactory();

  const connectionManager = new ConnectionManager(clientFactory, state, logger);
  const sessionManager = new SessionManager(clientFactory, state, logger);
  const turnStreamManager = new TurnStreamManager(clientFactory, state, logger);
  const cancellationManager = new CancellationManager(clientFactory, state, logger);

  const controller = new PatchPilotController(
    context,
    configManager,
    clientFactory,
    state,
    logger,
    connectionManager,
    sessionManager,
    turnStreamManager,
    cancellationManager
  );
  globalController = controller;

  const diffContentProvider = new ProposalDiffContentProvider(controller);
  const reviewPanelProvider = new ReviewPanelProvider(controller, diffContentProvider);
  const agentViewProvider = new AgentViewProvider(controller, () => reviewPanelProvider.open());

  // Register read-only diff content provider for native vscode.diff inspection
  const diffProviderReg = vscode.workspace.registerTextDocumentContentProvider(
    PATCHPILOT_PROPOSAL_SCHEME,
    diffContentProvider
  );

  // Register primary sidebar Agent WebviewView
  const viewProviderReg = vscode.window.registerWebviewViewProvider(
    AGENT_VIEW_ID,
    agentViewProvider,
    { webviewOptions: { retainContextWhenHidden: true } }
  );

  // Status bar item
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = "patchpilot.openAgent";
  statusBarItem.text = state.getStatusBarText();
  statusBarItem.tooltip = "PatchPilot — Click to open Agent panel";
  statusBarItem.show();

  const stateListener = state.onDidChange(() => {
    statusBarItem.text = state.getStatusBarText();
  });

  // Workspace Trust listener: refresh UI when trust is granted
  const trustSub =
    typeof vscode.workspace.onDidGrantWorkspaceTrust === "function"
      ? vscode.workspace.onDidGrantWorkspaceTrust(() => {
        logger.info("Workspace trust granted. PatchPilot workspace tools are now enabled.");
        controller.emitUiUpdate();
      })
      : { dispose: () => { } };

  // Register MVP commands
  const mvpCmds = registerMvpCommands(controller, agentViewProvider, reviewPanelProvider, logger);

  // Register Milestone 0 compatible commands
  const checkConnCmd = registerCheckConnectionCommand(context, configManager, connectionManager, logger);
  const startSessionCmd = registerStartSessionCommand(context, configManager, sessionManager, logger);
  const sendTestMsgCmd = registerSendTestMessageCommand(
    context,
    configManager,
    sessionManager,
    turnStreamManager,
    logger
  );
  const cancelTurnCmd = registerCancelTurnCommand(context, configManager, cancellationManager, logger);
  const showOutputCmd = registerShowOutputCommand(logger);
  const tokenCmds = registerTokenCommands(configManager, logger);

  context.subscriptions.push(
    statusBarItem,
    stateListener,
    trustSub,
    diffProviderReg,
    viewProviderReg,
    diffContentProvider,
    agentViewProvider,
    reviewPanelProvider,
    ...mvpCmds,
    checkConnCmd,
    startSessionCmd,
    sendTestMsgCmd,
    cancelTurnCmd,
    showOutputCmd,
    ...tokenCmds
  );

  logger.info("PatchPilot extension activated cleanly. Agent view, review panel, and commands registered.");

  return {
    state,
    logger,
    connectionManager,
    sessionManager,
    turnStreamManager,
    cancellationManager,
    controller,
    agentViewProvider,
    reviewPanelProvider,
  };
}

export async function deactivate(): Promise<void> {
  if (globalController) {
    try {
      await globalController.dispose();
    } catch {
      // Best-effort MCP child shutdown on deactivation
    }
    globalController = undefined;
  }
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
