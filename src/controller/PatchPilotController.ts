import * as crypto from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  CONFIG_SECTION,
  ConfigurationManager,
  DEFAULT_TRUEFORGE_BASE_URL,
  TrueForgeResolvedConfig,
} from "../config/configuration";
import {
  assembleWorkspaceContext,
  ContextPlan,
  formatContextPlanSummary,
} from "../context/contextAssembler";
import { parseMentions } from "../context/mentionParser";
import { ILogger } from "../output/logger";
import { resolveCanonicalWorkspaceRoot } from "../security/pathGuard";
import { sanitizeSecretText } from "../security/secretFilter";
import { ExtensionState } from "../state/extensionState";
import {
  DEFAULT_PATCHPILOT_AGENT_NAME,
  TrueForgeAgentManager,
} from "../trueforge/agentManager";
import { ApprovalManager, PendingToolApproval } from "../trueforge/approvalManager";
import { CancellationManager, CancellationResult } from "../trueforge/cancellationManager";
import { ITrueForgeClientFactory } from "../trueforge/clientFactory";
import {
  ConnectionCheckResult,
  ConnectionManager,
  TrueForgeDiagnosticState,
} from "../trueforge/connectionManager";
import { SessionManager } from "../trueforge/sessionManager";
import { TurnExecutionResult, TurnStreamManager } from "../trueforge/turnStream";
import { applyAcceptedProposals, ApplyAcceptedResult } from "../workspace/hunkReview";
import { computeSha256, HunkDecision } from "../workspace/patchEngine";
import { FileProposal, InlineSelectionConstraint } from "../workspace/proposalStore";
import { UndoManager, UndoResult } from "../workspace/undoManager";
import {
  createVscodeSymbolLookup,
  createVscodeWorkspaceMutations,
} from "../workspace/vscodeMutations";
import {
  DEFAULT_MCP_CONNECTOR_NAME,
  WorkspaceMcpAdapter,
} from "../workspace/WorkspaceMcpAdapter";

export interface ToolActivityItem {
  id: string;
  toolName: string;
  serverName?: string;
  argumentsPreview: string;
  status: "running" | "completed" | "awaiting_approval" | "denied" | "error";
  resultPreview?: string;
  timestamp: string;
}

export interface ChatTimelineEntry {
  id: string;
  role: "user" | "assistant" | "system" | "error";
  content: string;
  timestamp: string;
  modelName?: string;
}

export interface AgentUiSnapshot {
  workspaceName: string | null;
  workspaceRoot: string | null;
  workspaceFolders: Array<{ name: string; fsPath: string }>;
  workspaceTrusted: boolean;
  connectionStatus: string;
  diagnosticState: TrueForgeDiagnosticState | "UNCHECKED";
  connectionMessage: string;
  serverUrl: string;
  configuredAgentName: string;
  selectedModelName: string | null;
  availableModels: string[];
  mcpStatus: string;
  mcpEndpointUrl: string | null;
  activeSessionId: string | null;
  activeTurnId: string | null;
  turnStatus: string;
  currentOperation: string;
  messages: ChatTimelineEntry[];
  streamingText: string;
  toolActivity: ToolActivityItem[];
  pendingApprovals: PendingToolApproval[];
  contextPlan: ContextPlan | null;
  proposals: FileProposal[];
  canUndo: boolean;
  lastUndoLabel: string | null;
}

export interface InlineEditPayload {
  relativePath: string;
  absolutePath: string;
  startLine: number;
  endLine: number;
  selectedText: string;
  surroundingContext: string;
  originalVersion: number;
  originalSha256: string;
  instruction: string;
}

export class PatchPilotController {
  private selectedWorkspaceRoot: string | null = null;
  private lockedTurnWorkspaceRoot: string | null = null;
  private activeRunId: string | null = null;
  private lastConnectionCheck: ConnectionCheckResult | null = null;
  private lastContextPlan: ContextPlan | null = null;
  private currentOperation = "Idle";
  private streamingText = "";
  private readonly messages: ChatTimelineEntry[] = [];
  private readonly toolActivity: ToolActivityItem[] = [];
  private readonly uiListeners: Array<(snapshot: AgentUiSnapshot) => void> = [];
  private readonly proposalListeners: Array<(proposals: FileProposal[]) => void> = [];
  private readonly undoManager: UndoManager;
  private readonly mcpAdapter: WorkspaceMcpAdapter;
  private readonly agentManager: TrueForgeAgentManager;
  private readonly approvalManager: ApprovalManager;
  private readonly disposables: Array<() => void> = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly configManager: ConfigurationManager,
    private readonly clientFactory: ITrueForgeClientFactory,
    private readonly state: ExtensionState,
    private readonly logger: ILogger,
    private readonly connectionManager: ConnectionManager,
    private readonly sessionManager: SessionManager,
    private readonly turnStreamManager: TurnStreamManager,
    private readonly cancellationManager: CancellationManager
  ) {
    this.undoManager = new UndoManager();
    this.mcpAdapter = new WorkspaceMcpAdapter(clientFactory, logger, context.extensionPath);
    this.agentManager = new TrueForgeAgentManager(clientFactory, logger, context.extensionPath);
    this.approvalManager = new ApprovalManager(clientFactory, logger);

    // Initialize default workspace folder
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      this.selectedWorkspaceRoot = folders[0].uri.fsPath;
    }

    const unsubCrash = this.mcpAdapter.onCrash((reason) => {
      this.appendMessage("error", `Workspace MCP server stopped unexpectedly: ${reason}`);
      this.currentOperation = "MCP server crashed";
      this.emitUiUpdate();
      void vscode.window
        .showWarningMessage(
          `PatchPilot Workspace MCP server stopped unexpectedly: ${reason}`,
          "Restart MCP Server"
        )
        .then(async (choice) => {
          if (choice === "Restart MCP Server") {
            try {
              const restarted = await this.mcpAdapter.restartIfEligible();
              if (restarted) {
                const cfg = await this.configManager.getResolvedConfig();
                await this.mcpAdapter.registerWithTrueForge(cfg, cfg.mcpConnectorName);
                this.appendMessage("system", `Workspace MCP server restarted on ${restarted.url}.`);
                this.emitUiUpdate();
              }
            } catch (err: unknown) {
              this.logger.error("Failed to restart MCP server", err);
            }
          }
        });
    });
    this.disposables.push(unsubCrash);

    const unsubApprovals = this.approvalManager.onDidChange(() => {
      this.emitUiUpdate();
    });
    this.disposables.push(unsubApprovals);

    const stateSub = this.state.onDidChange(() => {
      this.emitUiUpdate();
    });
    this.disposables.push(() => stateSub.dispose());
  }

  public getMcpAdapter(): WorkspaceMcpAdapter {
    return this.mcpAdapter;
  }

  public getAgentManager(): TrueForgeAgentManager {
    return this.agentManager;
  }

  public getApprovalManager(): ApprovalManager {
    return this.approvalManager;
  }

  public getUndoManager(): UndoManager {
    return this.undoManager;
  }

  public onUiUpdate(listener: (snapshot: AgentUiSnapshot) => void): () => void {
    this.uiListeners.push(listener);
    return () => {
      const idx = this.uiListeners.indexOf(listener);
      if (idx >= 0) this.uiListeners.splice(idx, 1);
    };
  }

  public onProposalsUpdate(listener: (proposals: FileProposal[]) => void): () => void {
    this.proposalListeners.push(listener);
    return () => {
      const idx = this.proposalListeners.indexOf(listener);
      if (idx >= 0) this.proposalListeners.splice(idx, 1);
    };
  }

  public getSelectedWorkspaceRoot(): string | null {
    if (this.lockedTurnWorkspaceRoot) {
      return this.lockedTurnWorkspaceRoot;
    }
    if (this.selectedWorkspaceRoot) {
      return this.selectedWorkspaceRoot;
    }
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      this.selectedWorkspaceRoot = folders[0].uri.fsPath;
      return this.selectedWorkspaceRoot;
    }
    return null;
  }

  public async selectWorkspaceFolder(targetFsPath?: string): Promise<string | null> {
    if (this.state.turnStatus === "RUNNING" || this.state.turnStatus === "PAUSED") {
      vscode.window.showWarningMessage(
        "PatchPilot: Cannot switch workspace folder while an agent turn is active. Cancel or wait for the current turn to complete."
      );
      return this.getSelectedWorkspaceRoot();
    }

    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      vscode.window.showWarningMessage("PatchPilot: Open a folder in VS Code first.");
      return null;
    }

    if (targetFsPath) {
      const matched = folders.find((f) => f.uri.fsPath === targetFsPath);
      if (matched) {
        this.selectedWorkspaceRoot = matched.uri.fsPath;
        this.emitUiUpdate();
        return this.selectedWorkspaceRoot;
      }
    }

    const picked = await vscode.window.showQuickPick(
      folders.map((f) => ({
        label: f.name,
        description: f.uri.fsPath,
        fsPath: f.uri.fsPath,
      })),
      {
        title: "PatchPilot: Select Active Workspace Folder",
        placeHolder: "Choose which workspace root PatchPilot MCP tools are bound to",
      }
    );

    if (picked) {
      this.selectedWorkspaceRoot = picked.fsPath;
      this.logger.info(`Active PatchPilot workspace root set to: ${picked.fsPath}`);
      this.emitUiUpdate();
      this.emitProposalsUpdate();
    }
    return this.selectedWorkspaceRoot;
  }

  public isWorkspaceTrusted(): boolean {
    // Respect VS Code Workspace Trust; default true only in unit-test mock where property is absent
    return vscode.workspace.isTrusted !== false;
  }

  private ensureTrustedWorkspace(): string | null {
    if (!this.isWorkspaceTrusted()) {
      void vscode.window
        .showWarningMessage(
          "PatchPilot cannot start workspace tools in an untrusted workspace. Trust this workspace to allow PatchPilot to read, search, and propose edits.",
          "Manage Workspace Trust"
        )
        .then((choice) => {
          if (choice === "Manage Workspace Trust") {
            void vscode.commands.executeCommand("workbench.trust.manage");
          }
        });
      return null;
    }

    const root = this.getSelectedWorkspaceRoot();
    if (!root) {
      vscode.window.showWarningMessage(
        "PatchPilot: No workspace folder is open. Open a project folder in VS Code first."
      );
      return null;
    }
    return resolveCanonicalWorkspaceRoot(root);
  }

  public getProposals(): FileProposal[] {
    const store = this.mcpAdapter.getProposalStore();
    return store ? store.listProposals() : [];
  }

  public getProposalById(proposalId: string): FileProposal | undefined {
    const store = this.mcpAdapter.getProposalStore();
    return store ? store.getProposal(proposalId) : undefined;
  }

  public async getUiSnapshot(): Promise<AgentUiSnapshot> {
    const config = await this.configManager.getResolvedConfig();
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => ({
      name: f.name,
      fsPath: f.uri.fsPath,
    }));
    const activeRoot = this.getSelectedWorkspaceRoot();
    const mcpStatus = this.mcpAdapter.getStatus();
    const lastBatch = this.undoManager.peekLastBatch();

    return {
      workspaceName: activeRoot ? path.basename(activeRoot) : null,
      workspaceRoot: activeRoot,
      workspaceFolders: folders,
      workspaceTrusted: this.isWorkspaceTrusted(),
      connectionStatus: this.state.connectionStatus,
      diagnosticState: this.lastConnectionCheck?.diagnosticState ?? "UNCHECKED",
      connectionMessage:
        this.lastConnectionCheck?.message ??
        this.state.connectionDetails ??
        "Click 'Check TrueForge' or 'Configure TrueForge' to connect.",
      serverUrl: config.baseUrl,
      configuredAgentName: config.agentName || "(not configured)",
      selectedModelName:
        config.modelName ||
        this.lastConnectionCheck?.availableModels[0]?.name ||
        null,
      availableModels: (this.lastConnectionCheck?.availableModels ?? []).map((m) => m.name),
      mcpStatus: mcpStatus.state,
      mcpEndpointUrl: mcpStatus.url,
      activeSessionId: this.state.activeSessionId ?? null,
      activeTurnId: this.state.activeTurnId ?? null,
      turnStatus: this.state.turnStatus,
      currentOperation: this.currentOperation,
      messages: [...this.messages],
      streamingText: this.streamingText,
      toolActivity: [...this.toolActivity],
      pendingApprovals: this.approvalManager.getPendingApprovals(),
      contextPlan: this.lastContextPlan,
      proposals: this.getProposals(),
      canUndo: this.undoManager.hasUndoableBatch(),
      lastUndoLabel: lastBatch
        ? `${lastBatch.entries.length} file(s) at ${new Date(lastBatch.appliedAt).toLocaleTimeString()}`
        : null,
    };
  }

  public emitUiUpdate(): void {
    void this.getUiSnapshot().then((snapshot) => {
      for (const listener of this.uiListeners) {
        try {
          listener(snapshot);
        } catch {
          // Ignore UI listener error
        }
      }
    });
  }

  public emitProposalsUpdate(): void {
    const proposals = this.getProposals();
    for (const listener of this.proposalListeners) {
      try {
        listener(proposals);
      } catch {
        // Ignore listener error
      }
    }
    this.emitUiUpdate();
  }

  private appendMessage(
    role: ChatTimelineEntry["role"],
    content: string,
    modelName?: string
  ): void {
    this.messages.push({
      id: `msg-${crypto.randomBytes(4).toString("hex")}`,
      role,
      content: sanitizeSecretText(content),
      timestamp: new Date().toISOString(),
      modelName,
    });
    if (this.messages.length > 100) {
      this.messages.shift();
    }
  }

  /**
   * Runs full TrueForge diagnostic check (server reachability, auth, models, MCP connector, agent).
   */
  public async checkTrueForge(): Promise<ConnectionCheckResult> {
    this.currentOperation = "Checking TrueForge connection...";
    this.emitUiUpdate();

    const config = await this.configManager.getResolvedConfig();
    const res = await this.connectionManager.checkConnection(config);
    this.lastConnectionCheck = res;
    this.currentOperation = res.diagnosticState === "CONNECTED" ? "Ready" : res.diagnosticState;
    this.emitUiUpdate();
    return res;
  }

  /**
   * Guided interactive setup flow: verifies TrueForge, selects a configured model,
   * starts & registers the local MCP workspace server, and creates/updates the PatchPilot agent.
   */
  public async configureTrueForge(): Promise<boolean> {
    const config = await this.configManager.getResolvedConfig();

    // Step 1: Server URL
    const baseUrlInput = await vscode.window.showInputBox({
      title: "PatchPilot Setup (1/3): TrueForge Server URL",
      prompt: "Enter your local or configured TrueForge server base URL",
      value: config.baseUrl || DEFAULT_TRUEFORGE_BASE_URL,
      ignoreFocusOut: true,
    });
    if (baseUrlInput === undefined) {
      return false;
    }

    const baseUrl = baseUrlInput.trim() || DEFAULT_TRUEFORGE_BASE_URL;
    await this.configManager.updateSetting(CONFIG_SECTION, "baseUrl", baseUrl);

    // Step 2: Connection & Model discovery
    const check = await this.checkTrueForge();
    if (check.diagnosticState === "SERVER_NOT_RUNNING") {
      const action = await vscode.window.showErrorMessage(
        `TrueForge server is not running at ${baseUrl}. Start it with: npx @truefoundry/trueforge@latest`,
        "Copy Start Command"
      );
      if (action === "Copy Start Command") {
        await vscode.env.clipboard.writeText(
          'OUTBOUND_URL_ALLOWED_HOSTS=\'["127.0.0.1","localhost"]\' npx @truefoundry/trueforge@latest'
        );
      }
      return false;
    }

    if (check.diagnosticState === "AUTH_REQUIRED") {
      await vscode.commands.executeCommand("patchpilot.setToken");
      const recheck = await this.checkTrueForge();
      if (recheck.status !== "CONNECTED") {
        return false;
      }
    } else if (check.status !== "CONNECTED") {
      vscode.window.showErrorMessage(`PatchPilot: ${check.message}`);
      return false;
    }

    const updatedConfig = await this.configManager.getResolvedConfig();
    let selectedModel = updatedConfig.modelName || "";

    // Step 3: Model selection from TrueForge's configured model catalogue
    let availableModels = check.availableModels;
    if (availableModels.length === 0) {
      try {
        availableModels = await this.agentManager.listAvailableModels(updatedConfig);
      } catch {
        // Handled below
      }
    }

    if (availableModels.length > 0) {
      const pick = await vscode.window.showQuickPick(
        availableModels.map((m) => ({
          label: m.name,
          description: m.providerName ? `Provider: ${m.providerName} (${m.modelId})` : m.modelId,
          modelName: m.name,
        })),
        {
          title: "PatchPilot Setup (2/3): Select Configured TrueForge Model",
          placeHolder: "Choose a model configured in TrueForge (Models are managed in TrueForge)",
          ignoreFocusOut: true,
        }
      );
      if (!pick) {
        return false;
      }
      selectedModel = pick.modelName;
    } else {
      const action = await vscode.window.showWarningMessage(
        `No models are configured on TrueForge (${baseUrl}). Configure a model provider inside TrueForge Settings -> Model Providers first.`,
        "Open TrueForge UI",
        "Enter Model FQN Manually"
      );
      if (action === "Open TrueForge UI") {
        await vscode.env.openExternal(vscode.Uri.parse(baseUrl));
        return false;
      }
      if (action === "Enter Model FQN Manually") {
        const manual = await vscode.window.showInputBox({
          title: "PatchPilot Setup (2/3): TrueForge Model Identifier",
          prompt: "Enter the fully qualified model name configured in TrueForge (e.g. openai/gpt-4o)",
          value: selectedModel,
          ignoreFocusOut: true,
        });
        if (!manual || !manual.trim()) {
          return false;
        }
        selectedModel = manual.trim();
      } else {
        return false;
      }
    }

    await this.configManager.updateSetting(CONFIG_SECTION, "modelName", selectedModel);

    // Step 4: Start local MCP workspace server & register connector + agent in TrueForge
    const workspaceRoot = this.ensureTrustedWorkspace();
    const connectorName = updatedConfig.mcpConnectorName || DEFAULT_MCP_CONNECTOR_NAME;
    const agentName = updatedConfig.agentName || DEFAULT_PATCHPILOT_AGENT_NAME;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "PatchPilot: Configuring Workspace MCP Connector & TrueForge Agent...",
        cancellable: false,
      },
      async () => {
        const refreshedConfig = await this.configManager.getResolvedConfig();
        if (workspaceRoot) {
          await this.mcpAdapter.ensureStarted(workspaceRoot, {
            tokenBudget: refreshedConfig.contextTokenBudget,
          });
          const reg = await this.mcpAdapter.registerWithTrueForge(refreshedConfig, connectorName);
          if (!reg.registered) {
            throw new Error(
              `Could not register PatchPilot MCP connector with TrueForge: ${reg.error || "Unknown error"}. ` +
                `Ensure TrueForge was started with OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'.`
            );
          }
        }

        const ensured = await this.agentManager.ensurePatchPilotAgent(refreshedConfig, {
          modelName: selectedModel,
          agentName,
          mcpConnectorName: connectorName,
        });

        await this.configManager.updateSetting(CONFIG_SECTION, "agentName", ensured.agentName);
        this.appendMessage(
          "system",
          `Configured TrueForge agent "${ensured.agentName}" with model "${ensured.modelName}", deferred MCP loading (preload: false), context compaction, and human approvals for propose_edit & run_workspace_command.`
        );
      }
    );

    await this.checkTrueForge();
    vscode.window.showInformationMessage(
      `PatchPilot configured cleanly: agent "${agentName}" using TrueForge model "${selectedModel}".`
    );
    return true;
  }

  /**
   * Ensures the workspace MCP server is running and registered with TrueForge before a turn.
   */
  private async prepareWorkspaceAndTrueForge(
    workspaceRoot: string,
    config: TrueForgeResolvedConfig
  ): Promise<{ sessionId: string; runId: string }> {
    this.currentOperation = "Starting Workspace MCP server...";
    this.emitUiUpdate();

    await this.mcpAdapter.ensureStarted(workspaceRoot, {
      tokenBudget: config.contextTokenBudget,
    });

    const connectorName = config.mcpConnectorName || DEFAULT_MCP_CONNECTOR_NAME;
    this.currentOperation = "Syncing MCP connector with TrueForge...";
    this.emitUiUpdate();

    const reg = await this.mcpAdapter.registerWithTrueForge(config, connectorName);
    if (!reg.registered) {
      throw new Error(
        `TrueForge MCP connector registration failed: ${reg.error || "Unable to discover workspace tools"}. ` +
          `Verify TrueForge is running at ${config.baseUrl} with OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'.`
      );
    }

    // Create or reuse TrueForge session (never hardcode provider credentials or models)
    let sessionId = this.sessionManager.getActiveSessionId();
    if (!sessionId) {
      this.currentOperation = "Creating TrueForge session...";
      this.emitUiUpdate();

      if (config.agentName) {
        sessionId = await this.sessionManager.createSession(config);
      } else if (config.modelName) {
        const inlineSpec = this.agentManager.buildPatchPilotAgentSpec({
          modelName: config.modelName,
          mcpConnectorName: connectorName,
        });
        sessionId = await this.sessionManager.createSession(config, {
          agentOverride: { spec: inlineSpec },
        });
      } else {
        throw new Error(
          "No TrueForge agent or model is configured. Run 'PatchPilot: Configure TrueForge' first."
        );
      }
    }

    const runId = `run-${crypto.randomBytes(6).toString("hex")}`;
    return { sessionId, runId };
  }

  /**
   * Executes an Agent Mode or Inline Edit turn strictly through the TrueForge runtime.
   */
  public async startAgentRun(
    userPrompt: string,
    options: {
      inlineEdit?: InlineEditPayload;
      forceNewSession?: boolean;
      onProposalsReady?: () => void;
    } = {}
  ): Promise<TurnExecutionResult | undefined> {
    const trimmed = userPrompt.trim();
    if (!trimmed) {
      return undefined;
    }

    const workspaceRoot = this.ensureTrustedWorkspace();
    if (!workspaceRoot) {
      return undefined;
    }

    if (this.state.turnStatus === "RUNNING" || this.state.turnStatus === "PAUSED") {
      vscode.window.showWarningMessage(
        "PatchPilot: An agent turn is already active. Cancel it or wait for completion before starting another."
      );
      return undefined;
    }

    const config = await this.configManager.getResolvedConfig();
    if (options.forceNewSession) {
      this.sessionManager.getActiveSessionId() && this.state.setActiveSessionId(undefined);
    }

    // Lock workspace root for the duration of this turn
    this.lockedTurnWorkspaceRoot = workspaceRoot;
    this.streamingText = "";
    this.toolActivity.length = 0;
    this.appendMessage(
      "user",
      options.inlineEdit
        ? `[Inline Edit: ${options.inlineEdit.relativePath}:${options.inlineEdit.startLine}-${options.inlineEdit.endLine}] ${trimmed}`
        : trimmed
    );

    try {
      // 1. Assemble visible local Context Plan (for UI budget & explicit @file/@symbol handling)
      this.currentOperation = "Assembling context plan...";
      this.emitUiUpdate();

      const mentions = parseMentions(trimmed);
      const contextPlan = await assembleWorkspaceContext(workspaceRoot, trimmed, {
        tokenBudget: config.contextTokenBudget,
        externalSymbolLookup: createVscodeSymbolLookup(workspaceRoot),
        explicitFiles: options.inlineEdit ? [options.inlineEdit.relativePath] : undefined,
      });
      this.lastContextPlan = contextPlan;
      this.logger.info(`Context Plan:\n${formatContextPlanSummary(contextPlan)}`);

      if (contextPlan.unknownReferences.length > 0) {
        const warnText = contextPlan.unknownReferences
          .map((u) => `@${u.kind}:${u.reference} (${u.reason})`)
          .join("; ");
        this.appendMessage("system", `Unresolved reference(s) reported: ${warnText}`);
      }

      // 2. Prepare MCP server, TrueForge connector, and session
      const { sessionId, runId } = await this.prepareWorkspaceAndTrueForge(workspaceRoot, config);
      this.activeRunId = runId;

      const selectionConstraint: InlineSelectionConstraint | null = options.inlineEdit
        ? {
            relativePath: options.inlineEdit.relativePath,
            startLine: options.inlineEdit.startLine,
            endLine: options.inlineEdit.endLine,
          }
        : null;
      await this.mcpAdapter.setActiveRun(runId, selectionConstraint);

      // 3. Build prompt payload for TrueForge:
      //    - For Inline Edit: include file path, selection range, selected source, surrounding context, instruction.
      //    - For Agent Mode with explicit @file/@symbol: include resolved explicit references ONLY.
      //    - For Agent Mode WITHOUT explicit file mentions (e.g. Task B): DO NOT leak discovered filenames;
      //      TrueForge independently searches and discovers files via MCP tools!
      let finalPrompt = trimmed;
      if (options.inlineEdit) {
        const ie = options.inlineEdit;
        finalPrompt = [
          "Inline Edit Request:",
          `File: ${ie.relativePath}`,
          `Selected Line Range: ${ie.startLine}-${ie.endLine}`,
          "",
          "Selected Code:",
          "```",
          ie.selectedText,
          "```",
          "",
          "Surrounding Context (with 1-based line numbers):",
          "```",
          ie.surroundingContext,
          "```",
          "",
          `User Instruction: ${ie.instruction}`,
          "",
          "Use read_workspace_file if you need additional context, then call propose_edit with the complete updated file content so the user can review the diff hunk by hunk. Keep edits focused on the selected region unless surrounding lines genuinely require updates.",
        ].join("\n");
      } else if (mentions.fileMentions.length > 0 || mentions.symbolMentions.length > 0) {
        const explicitBlocks: string[] = [];
        for (const f of contextPlan.selectedFiles) {
          if (f.source === "explicit_file" || f.source === "explicit_symbol") {
            const snips = f.snippets.map((s) => s.content).join("\n");
            explicitBlocks.push(`--- Explicit Reference: ${f.relativePath} (${f.reason}) ---\n${snips}`);
          }
        }
        if (explicitBlocks.length > 0) {
          finalPrompt = `${trimmed}\n\nExplicitly referenced workspace context:\n${explicitBlocks.join("\n\n")}`;
        }
      }

      // 4. Execute real TrueForge turn with full streaming + approval + tool activity callbacks
      this.currentOperation = "Streaming TrueForge agent turn...";
      this.emitUiUpdate();

      const result = await this.turnStreamManager.executeTurn(config, sessionId, finalPrompt, {
        approvalManager: this.approvalManager,
        callbacks: {
          onTurnCreated: (turnId) => {
            this.currentOperation = `Turn ${turnId.slice(0, 10)}... running`;
            this.emitUiUpdate();
          },
          onDelta: (delta) => {
            this.streamingText += delta;
            this.emitUiUpdate();
          },
          onToolCall: (tc) => {
            this.currentOperation = `Running MCP tool: ${tc.name}`;
            this.toolActivity.push({
              id: tc.id,
              toolName: tc.name,
              serverName: tc.serverName,
              argumentsPreview: sanitizeSecretText(tc.argumentsRaw).slice(0, 300),
              status: "running",
              timestamp: new Date().toISOString(),
            });
            this.emitUiUpdate();
          },
          onApprovalRequired: (pending) => {
            this.currentOperation = `Waiting for human approval (${pending.map((p) => p.toolName).join(", ")})`;
            for (const p of pending) {
              const item = this.toolActivity.find((t) => t.id === p.toolCallId);
              if (item) {
                item.status = "awaiting_approval";
              }
            }
            this.emitUiUpdate();
          },
          onToolResponse: (callId, toolName, content) => {
            const item = this.toolActivity.find((t) => t.id === callId);
            if (item) {
              item.status = content.startsWith("Error executing tool") ? "error" : "completed";
              item.resultPreview = content.slice(0, 400);
            }
            this.currentOperation = `Processed tool result: ${toolName}`;
            if (toolName === "propose_edit") {
              this.emitProposalsUpdate();
            } else {
              this.emitUiUpdate();
            }
          },
          onCompaction: (phase) => {
            this.appendMessage(
              "system",
              phase === "started"
                ? "TrueForge context compaction started to preserve token budget."
                : "TrueForge context compaction finished."
            );
            this.emitUiUpdate();
          },
          onRetry: (attempt, maxAttempts, delayMs, reason) => {
            this.currentOperation = `Retrying TrueForge (${attempt}/${maxAttempts}) in ${delayMs}ms...`;
            this.appendMessage(
              "system",
              `Transient TrueForge failure (${reason}). Retrying attempt ${attempt}/${maxAttempts} in ${delayMs}ms...`
            );
            this.emitUiUpdate();
          },
          onTurnDone: (status, errMsg) => {
            if (status === "ERROR") {
              this.currentOperation = "Turn failed";
              this.appendMessage("error", errMsg || "TrueForge turn ended with an error.");
            } else if (status === "CANCELLED") {
              this.currentOperation = "Turn cancelled";
              this.appendMessage("system", "Turn cancelled cleanly; no unreviewed changes were applied.");
            } else {
              this.currentOperation = "Completed";
            }
          },
        },
      });

      if (result.accumulatedText.trim().length > 0) {
        this.appendMessage("assistant", result.accumulatedText.trim(), result.modelName);
      }
      this.streamingText = "";

      // Check inline edit staleness if editor changed during turn
      if (options.inlineEdit) {
        const currentDocs = vscode.workspace.textDocuments ?? [];
        const openDoc = currentDocs.find((d) => d.uri.fsPath === options.inlineEdit!.absolutePath);
        if (openDoc && computeSha256(openDoc.getText()) !== options.inlineEdit.originalSha256) {
          this.appendMessage(
            "system",
            `Warning: "${options.inlineEdit.relativePath}" was edited while the inline edit was running. Proposals will be checked for staleness before apply.`
          );
        }
      }

      this.emitProposalsUpdate();
      if (this.getProposals().length > 0 && result.terminalStatus === "COMPLETED") {
        options.onProposalsReady?.();
      }
      return result;
    } catch (err: unknown) {
      const sanitized = sanitizeSecretText(err instanceof Error ? err.message : String(err));
      this.streamingText = "";
      this.currentOperation = "Error";
      this.appendMessage(
        "error",
        `PatchPilot run failed cleanly (no workspace files modified): ${sanitized}`
      );
      this.emitUiUpdate();
      vscode.window.showErrorMessage(`PatchPilot: ${sanitized}`);
      return undefined;
    } finally {
      this.lockedTurnWorkspaceRoot = null;
      this.activeRunId = null;
      await this.mcpAdapter.setActiveRun(null, null).catch(() => {});
      this.emitUiUpdate();
    }
  }

  /**
   * Captures the active VS Code editor selection and runs Inline Edit via TrueForge.
   */
  public async runInlineEdit(
    instructionOverride?: string,
    onProposalsReady?: () => void
  ): Promise<TurnExecutionResult | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage(
        "PatchPilot Inline Edit: Open a source file and select a code region first."
      );
      return undefined;
    }

    const workspaceRoot = this.ensureTrustedWorkspace();
    if (!workspaceRoot) {
      return undefined;
    }

    const doc = editor.document;
    const absPath = doc.uri.fsPath;
    const relativePath = path.relative(workspaceRoot, absPath).replace(/\\/g, "/");
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      vscode.window.showErrorMessage(
        `PatchPilot Inline Edit: Active file "${absPath}" is outside the selected workspace root "${workspaceRoot}".`
      );
      return undefined;
    }

    const selection = editor.selection;
    if (selection.isEmpty) {
      vscode.window.showWarningMessage(
        "PatchPilot Inline Edit: Select the function or lines you want to edit first."
      );
      return undefined;
    }

    const instruction =
      instructionOverride ??
      (await vscode.window.showInputBox({
        title: `PatchPilot Inline Edit (${relativePath}:${selection.start.line + 1}-${selection.end.line + 1})`,
        prompt: "Describe the requested change in plain language",
        placeHolder:
          "e.g. Treat the values 'off' and 'n' as false as well, case-insensitively...",
        ignoreFocusOut: true,
      }));

    if (!instruction || !instruction.trim()) {
      return undefined;
    }

    const startLine = selection.start.line + 1;
    const endLine = selection.end.line + 1;
    const selectedText = doc.getText(selection);
    const fullText = doc.getText();
    const lines = fullText.split(/\r?\n/);
    const ctxStart = Math.max(0, selection.start.line - 15);
    const ctxEnd = Math.min(lines.length - 1, selection.end.line + 15);
    const surroundingContext = lines
      .slice(ctxStart, ctxEnd + 1)
      .map((l, idx) => `${ctxStart + idx + 1}: ${l}`)
      .join("\n");

    const payload: InlineEditPayload = {
      relativePath,
      absolutePath: absPath,
      startLine,
      endLine,
      selectedText,
      surroundingContext,
      originalVersion: doc.version,
      originalSha256: computeSha256(fullText),
      instruction: instruction.trim(),
    };

    return this.startAgentRun(instruction.trim(), {
      inlineEdit: payload,
      onProposalsReady,
    });
  }

  /**
   * Approves or denies a genuine TrueForge tool.approval_required event.
   */
  public async respondToApproval(
    toolCallId: string,
    allow: boolean,
    reason?: string
  ): Promise<void> {
    const config = await this.configManager.getResolvedConfig();
    const updated = await this.approvalManager.submitDecision(config, toolCallId, allow, reason);
    const item = this.toolActivity.find((t) => t.id === toolCallId);
    if (item) {
      item.status = allow ? "running" : "denied";
    }
    this.appendMessage(
      "system",
      `Human ${allow ? "APPROVED" : "DENIED"} tool "${updated.toolName}" (${toolCallId}).`
    );
    this.emitUiUpdate();
  }

  /**
   * Cancels the active TrueForge turn, aborts local MCP subprocesses, and discards unaccepted proposals.
   */
  public async cancelActiveRun(): Promise<CancellationResult> {
    const config = await this.configManager.getResolvedConfig();
    this.currentOperation = "Cancelling run...";
    this.emitUiUpdate();

    const res = await this.cancellationManager.cancelActiveTurn(config, {
      runId: this.activeRunId ?? undefined,
      approvalManager: this.approvalManager,
      cancelLocalMcp: (runId) => this.mcpAdapter.cancelActiveOperations(runId),
    });

    this.currentOperation = "Cancelled";
    this.emitProposalsUpdate();
    return res;
  }

  public setHunkDecision(proposalId: string, hunkId: string, decision: HunkDecision): void {
    const store = this.mcpAdapter.getProposalStore();
    if (!store) return;
    store.setHunkDecision(proposalId, hunkId, decision);
    this.emitProposalsUpdate();
  }

  public setAllHunksDecision(proposalId: string, decision: HunkDecision): void {
    const store = this.mcpAdapter.getProposalStore();
    if (!store) return;
    store.setAllHunksDecision(proposalId, decision);
    this.emitProposalsUpdate();
  }

  public async applyAcceptedChanges(): Promise<ApplyAcceptedResult | undefined> {
    const workspaceRoot = this.ensureTrustedWorkspace();
    const store = this.mcpAdapter.getProposalStore();
    if (!workspaceRoot || !store) {
      vscode.window.showInformationMessage("PatchPilot: No active proposals to apply.");
      return undefined;
    }

    const result = await applyAcceptedProposals(
      workspaceRoot,
      store,
      this.undoManager,
      createVscodeWorkspaceMutations()
    );

    if (result.appliedFiles.length > 0) {
      this.appendMessage("system", result.message);
      vscode.window.showInformationMessage(`PatchPilot: ${result.message}`);
    } else if (result.staleConflicts.length > 0) {
      this.appendMessage("error", result.message);
      vscode.window.showWarningMessage(`PatchPilot: ${result.message}`);
    } else {
      vscode.window.showInformationMessage(`PatchPilot: ${result.message}`);
    }

    this.emitProposalsUpdate();
    return result;
  }

  public async discardProposals(): Promise<number> {
    const store = this.mcpAdapter.getProposalStore();
    const count = store ? store.discardAllPending() : 0;
    this.appendMessage("system", `Discarded ${count} pending file proposal(s).`);
    this.emitProposalsUpdate();
    return count;
  }

  public async undoLastApply(): Promise<UndoResult> {
    const result = await this.undoManager.undoLastApply(createVscodeWorkspaceMutations());
    if (result.success) {
      this.appendMessage("system", result.message);
      vscode.window.showInformationMessage(`PatchPilot: ${result.message}`);
    } else {
      this.appendMessage("error", result.message);
      vscode.window.showWarningMessage(`PatchPilot: ${result.message}`);
    }
    this.emitUiUpdate();
    return result;
  }

  public resetSession(): void {
    this.state.setActiveSessionId(undefined);
    this.messages.length = 0;
    this.toolActivity.length = 0;
    this.streamingText = "";
    this.lastContextPlan = null;
    this.currentOperation = "Session reset";
    this.emitUiUpdate();
  }

  public async dispose(): Promise<void> {
    for (const unsub of this.disposables) {
      unsub();
    }
    this.disposables.length = 0;
    this.approvalManager.clearHistory();
    await this.mcpAdapter.dispose();
  }
}
