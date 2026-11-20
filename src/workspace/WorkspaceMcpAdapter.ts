import * as path from "node:path";
import { TrueForgeResolvedConfig } from "../config/configuration";
import { ILogger } from "../output/logger";
import { ITrueForgeClientFactory } from "../trueforge/clientFactory";
import { PATCHPILOT_MCP_TOOL_NAMES } from "./mcpServerCore";
import { InlineSelectionConstraint, ProposalStore } from "./proposalStore";
import { InlineEditContext } from "./rangeEdit";
import { ManagedMcpProcessStatus, WorkspaceProcessManager } from "./WorkspaceProcessManager";

/**
 * PatchPilot Extension-Side MCP Workspace Adapter
 *
 * Bridges the VS Code Extension Host, the out-of-process MCP workspace server,
 * the isolated ProposalStore, and TrueForge's remote MCP connector registry.
 */

export const DEFAULT_MCP_CONNECTOR_NAME = "patchpilot-workspace";

export interface McpRegistrationResult {
  registered: boolean;
  connectorName: string;
  endpointUrl: string;
  discoveredTools: string[];
  missingTools: string[];
  error?: string;
}

export class WorkspaceMcpAdapter {
  private readonly processManager: WorkspaceProcessManager;
  private proposalStore: ProposalStore | null = null;
  private currentWorkspaceRoot: string | null = null;
  private readonly serverScriptPath: string;
  private readonly clientFactory: ITrueForgeClientFactory;
  private readonly logger: ILogger;

  constructor(
    clientFactory: ITrueForgeClientFactory,
    logger: ILogger,
    extensionRootPath: string
  ) {
    this.clientFactory = clientFactory;
    this.logger = logger;
    this.serverScriptPath = path.join(extensionRootPath, "dist", "mcpServer.js");
    this.processManager = new WorkspaceProcessManager(logger);
  }

  public onCrash(listener: (reason: string) => void): () => void {
    return this.processManager.onCrash(listener);
  }

  public getStatus(): ManagedMcpProcessStatus {
    return this.processManager.getStatus();
  }

  public getWorkspaceRoot(): string | null {
    return this.currentWorkspaceRoot;
  }

  public getProposalStore(): ProposalStore | null {
    return this.proposalStore;
  }

  public async ensureStarted(
    workspaceRoot: string,
    options: { tokenBudget?: number; forceRestart?: boolean } = {}
  ): Promise<ManagedMcpProcessStatus> {
    const status = this.processManager.getStatus();
    if (
      !options.forceRestart &&
      status.state === "running" &&
      this.currentWorkspaceRoot === workspaceRoot &&
      this.proposalStore
    ) {
      return status;
    }

    if (this.currentWorkspaceRoot !== workspaceRoot || !this.proposalStore) {
      if (this.proposalStore) {
        this.proposalStore.cleanup();
      }
      this.proposalStore = new ProposalStore(workspaceRoot);
      this.currentWorkspaceRoot = workspaceRoot;
    }

    return this.processManager.start({
      workspaceRoot,
      proposalStoreDir: this.proposalStore.getStoreDir(),
      serverScriptPath: this.serverScriptPath,
      tokenBudget: options.tokenBudget,
    });
  }

  public async registerWithTrueForge(
    config: TrueForgeResolvedConfig,
    connectorName: string = DEFAULT_MCP_CONNECTOR_NAME
  ): Promise<McpRegistrationResult> {
    const endpointUrl = this.processManager.getEndpointUrl();
    const authToken = this.processManager.getAuthToken();
    const client = this.clientFactory.createClient(config);

    try {
      this.logger.info(
        `Registering PatchPilot MCP connector "${connectorName}" at ${endpointUrl} with TrueForge...`
      );
      await client.settings.mcpServers.createOrUpdate({
        manifest: {
          type: "remote",
          name: connectorName,
          url: endpointUrl,
          description:
            "PatchPilot isolated workspace MCP server (read, search, symbol lookup, context plan, proposal-only edits, disposable overlay command runner).",
          auth: {
            type: "header",
            headers: {
              Authorization: `Bearer ${authToken}`,
            },
          },
        },
      });

      const toolsResp = await client.mcpServers.listTools(connectorName);
      const discoveredTools = (toolsResp.data ?? [])
        .map((t) => (typeof t.name === "string" ? t.name : ""))
        .filter((name): name is string => name.length > 0)
        .sort();
      const missingTools = PATCHPILOT_MCP_TOOL_NAMES.filter((t) => !discoveredTools.includes(t));

      this.logger.info(
        `TrueForge discovered ${discoveredTools.length} PatchPilot MCP tool(s): [${discoveredTools.join(", ")}].`
      );

      return {
        registered: missingTools.length === 0,
        connectorName,
        endpointUrl,
        discoveredTools,
        missingTools,
        error:
          missingTools.length > 0
            ? `TrueForge connector missing expected tool(s): ${missingTools.join(", ")}`
            : undefined,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to register PatchPilot MCP connector with TrueForge: ${msg}`);
      return {
        registered: false,
        connectorName,
        endpointUrl,
        discoveredTools: [],
        missingTools: [...PATCHPILOT_MCP_TOOL_NAMES],
        error: msg,
      };
    }
  }

  public async setActiveRun(
    runId: string | null,
    selectionConstraint?: InlineSelectionConstraint | null,
    inlineEditContext?: InlineEditContext | null
  ): Promise<void> {
    if (this.proposalStore) {
      this.proposalStore.setActiveRun(runId, selectionConstraint, inlineEditContext);
    }
    await this.processManager.setActiveRun(runId, selectionConstraint, inlineEditContext);
  }

  public async cancelActiveOperations(
    runId?: string
  ): Promise<{ abortedCommands: number; discardedProposals: number }> {
    const res = await this.processManager.cancelActiveOperations(runId);
    if (runId && this.proposalStore) {
      this.proposalStore.markRunCancelled(runId);
    }
    return res;
  }

  public async restartIfEligible(): Promise<ManagedMcpProcessStatus | null> {
    return this.processManager.restartIfEligible();
  }

  public async checkHealth(): Promise<{ healthy: boolean; statusCode: number; error?: string }> {
    return this.processManager.checkHealth();
  }

  public async dispose(): Promise<void> {
    await this.processManager.stop();
    if (this.proposalStore) {
      this.proposalStore.cleanup();
      this.proposalStore = null;
    }
    this.currentWorkspaceRoot = null;
  }
}
