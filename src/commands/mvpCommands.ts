import * as vscode from "vscode";
import { PatchPilotController } from "../controller/PatchPilotController";
import { ILogger } from "../output/logger";
import { AgentViewProvider } from "../ui/AgentViewProvider";
import { ReviewPanelProvider } from "../ui/ReviewPanelProvider";

/**
 * Registers all PatchPilot MVP VS Code commands with real end-to-end behavior.
 */
export function registerMvpCommands(
  controller: PatchPilotController,
  agentView: AgentViewProvider,
  reviewPanel: ReviewPanelProvider,
  logger: ILogger
): vscode.Disposable[] {
  const openAgent = vscode.commands.registerCommand("patchpilot.openAgent", () => {
    agentView.focus();
  });

  const inlineEdit = vscode.commands.registerCommand(
    "patchpilot.inlineEdit",
    async (instructionArg?: string) => {
      return controller.runInlineEdit(
        typeof instructionArg === "string" ? instructionArg : undefined,
        () => reviewPanel.open()
      );
    }
  );

  const startAgentRun = vscode.commands.registerCommand(
    "patchpilot.startAgentRun",
    async (promptArg?: string) => {
      agentView.focus();
      const prompt =
        typeof promptArg === "string" && promptArg.trim().length > 0
          ? promptArg
          : await vscode.window.showInputBox({
              title: "PatchPilot: Start Agent Run",
              prompt:
                "Describe the coding task (optionally use @file:path or @symbol:name, or let TrueForge discover files)",
              placeHolder:
                "e.g. Add a new built-in CLI command flask config that prints masked JSON config...",
              ignoreFocusOut: true,
            });
      if (!prompt || !prompt.trim()) {
        return undefined;
      }
      return controller.startAgentRun(prompt, {
        onProposalsReady: () => reviewPanel.open(),
      });
    }
  );

  const cancelRun = vscode.commands.registerCommand("patchpilot.cancelRun", async () => {
    const res = await controller.cancelActiveRun();
    vscode.window.showInformationMessage(`PatchPilot: ${res.message}`);
    return res;
  });

  const reviewChanges = vscode.commands.registerCommand("patchpilot.reviewChanges", () => {
    reviewPanel.open();
  });

  const applyAcceptedChanges = vscode.commands.registerCommand(
    "patchpilot.applyAcceptedChanges",
    async () => {
      return controller.applyAcceptedChanges();
    }
  );

  const discardChanges = vscode.commands.registerCommand(
    "patchpilot.discardChanges",
    async () => {
      const count = await controller.discardProposals();
      vscode.window.showInformationMessage(`PatchPilot: Discarded ${count} pending proposal(s).`);
      return count;
    }
  );

  const undoLastApply = vscode.commands.registerCommand("patchpilot.undoLastApply", async () => {
    return controller.undoLastApply();
  });

  const checkTrueForge = vscode.commands.registerCommand("patchpilot.checkTrueForge", async () => {
    logger.show(true);
    const res = await controller.checkTrueForge();
    if (res.diagnosticState === "CONNECTED") {
      vscode.window.showInformationMessage(`PatchPilot: ${res.message}`);
    } else if (res.diagnosticState === "AUTH_REQUIRED") {
      const action = await vscode.window.showErrorMessage(
        `PatchPilot: ${res.message}`,
        "Set Access Token"
      );
      if (action === "Set Access Token") {
        await vscode.commands.executeCommand("patchpilot.setToken");
      }
    } else if (
      res.diagnosticState === "MODEL_NOT_CONFIGURED" ||
      res.diagnosticState === "AGENT_NOT_CONFIGURED" ||
      res.diagnosticState === "MCP_CONNECTOR_NOT_REGISTERED"
    ) {
      const action = await vscode.window.showWarningMessage(
        `PatchPilot: ${res.message}`,
        "Configure TrueForge"
      );
      if (action === "Configure TrueForge") {
        await controller.configureTrueForge();
      }
    } else {
      vscode.window.showErrorMessage(`PatchPilot: ${res.message}`);
    }
    return res;
  });

  const configureTrueForge = vscode.commands.registerCommand(
    "patchpilot.configureTrueForge",
    async () => {
      return controller.configureTrueForge();
    }
  );

  const showSession = vscode.commands.registerCommand("patchpilot.showSession", async () => {
    const snap = await controller.getUiSnapshot();
    logger.info("=== PatchPilot Active Session Summary ===");
    logger.info(`Workspace: ${snap.workspaceRoot || "(none)"} (trusted=${snap.workspaceTrusted})`);
    logger.info(`TrueForge Server: ${snap.serverUrl} (${snap.diagnosticState})`);
    logger.info(`Agent: ${snap.configuredAgentName} | Model: ${snap.selectedModelName || "(none)"}`);
    logger.info(`MCP Server: ${snap.mcpStatus} (${snap.mcpEndpointUrl || "not started"})`);
    logger.info(`Session ID: ${snap.activeSessionId || "(none)"} | Turn ID: ${snap.activeTurnId || "(none)"} (${snap.turnStatus})`);
    logger.info(`Pending Proposals: ${snap.proposals.length} | Undoable Batch: ${snap.canUndo}`);
    logger.show(false);
    return snap;
  });

  const selectWorkspace = vscode.commands.registerCommand(
    "patchpilot.selectWorkspace",
    async (fsPath?: string) => {
      return controller.selectWorkspaceFolder(typeof fsPath === "string" ? fsPath : undefined);
    }
  );

  return [
    openAgent,
    inlineEdit,
    startAgentRun,
    cancelRun,
    reviewChanges,
    applyAcceptedChanges,
    discardChanges,
    undoLastApply,
    checkTrueForge,
    configureTrueForge,
    showSession,
    selectWorkspace,
  ];
}
