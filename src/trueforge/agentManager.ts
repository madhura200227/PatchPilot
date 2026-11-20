import * as fs from "node:fs";
import * as path from "node:path";
import { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { TrueForgeResolvedConfig } from "../config/configuration";
import { ILogger } from "../output/logger";
import {
  PATCHPILOT_APPROVAL_REQUIRED_TOOLS,
  PATCHPILOT_MCP_TOOL_NAMES,
} from "../workspace/mcpServerCore";
import { DEFAULT_MCP_CONNECTOR_NAME } from "../workspace/WorkspaceMcpAdapter";
import { ITrueForgeClientFactory } from "./clientFactory";

/**
 * PatchPilot TrueForge Agent & Model Configuration Manager
 *
 * Manages:
 * - Retrieving configured models from TrueForge (never hardcoding provider/model code)
 * - Building exact SDK AgentSpec manifests with TrueForge context-engineering features:
 *     * Deferred MCP tool loading (preload: false)
 *     * Context compaction enabled (contextManagement.compaction.enabled: true)
 *     * Large tool response offloading enabled (contextManagement.largeToolResponse.enabled: true)
 *     * Literal tool-name approvals (requireApprovalForTools: ["propose_edit", "run_workspace_command"])
 * - Creating or updating the named PatchPilot agent on TrueForge via client.agents.create/update
 */

export const DEFAULT_PATCHPILOT_AGENT_NAME = "patchpilot";

export interface ConfiguredTrueForgeModel {
  name: string;
  modelId: string;
  providerName?: string;
  warning?: string;
}

export interface AgentTemplateFile {
  name: string;
  description: string;
  manifest: {
    model: { name: string };
    instructions: string;
    mcp_servers: Array<{
      name: string;
      preload: boolean;
      enable_tools: string[];
      require_approval_for_tools: string[];
    }>;
    config: {
      iteration_limit: number;
      context_management: {
        compaction: { enabled: boolean };
        large_tool_response: { enabled: boolean };
      };
    };
  };
}

export interface EnsureAgentResult {
  agentId: string;
  agentName: string;
  modelName: string;
  mcpConnectorName: string;
  created: boolean;
  contextEngineering: {
    deferredToolLoading: boolean;
    compactionEnabled: boolean;
    largeToolResponseEnabled: boolean;
    approvalRequiredTools: string[];
  };
}

const DEFAULT_INSTRUCTIONS = `You are PatchPilot, a precision coding agent running inside TrueForge and connected to a Visual Studio Code workspace through the patchpilot-workspace MCP server.

Operating Rules:
1. Never assume file contents or file locations. Use get_context_plan, search_workspace, list_workspace_files, read_workspace_symbol, and read_workspace_file to inspect the codebase thoroughly before proposing edits.
2. When the user does not name files, independently discover all relevant source, test, and documentation files using search_workspace and get_context_plan.
3. Submit file changes using propose_edit. Every propose_edit call stages a diff in PatchPilot's isolated proposal store for human hunk-by-hunk review without mutating the user's working tree.
4. For inline edits targeting a selected region, keep edits tightly scoped to the selected code unless surrounding imports or docstrings genuinely require changes; if you expand beyond the selection, state why clearly.
5. Verify proposed edits using run_workspace_command (executes allowlisted commands inside a disposable overlay containing your proposed edits).
6. Never fabricate tool outputs, file hashes, or test results.`;

export class TrueForgeAgentManager {
  constructor(
    private readonly clientFactory: ITrueForgeClientFactory,
    private readonly logger: ILogger,
    private readonly extensionRootPath?: string
  ) {}

  public loadAgentTemplate(): AgentTemplateFile | null {
    if (!this.extensionRootPath) {
      return null;
    }
    const candidate = path.join(this.extensionRootPath, "agents", "patchpilot.agent.json");
    if (!fs.existsSync(candidate)) {
      return null;
    }
    try {
      const raw = fs.readFileSync(candidate, "utf8");
      return JSON.parse(raw) as AgentTemplateFile;
    } catch (err: unknown) {
      this.logger.warn(
        `Could not parse agents/patchpilot.agent.json template: ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
  }

  /**
   * Lists models configured on the TrueForge server via client.models.list().
   */
  public async listAvailableModels(
    config: TrueForgeResolvedConfig
  ): Promise<ConfiguredTrueForgeModel[]> {
    const client = this.clientFactory.createClient(config);
    const resp = await client.models.list();
    const models = resp.data ?? [];
    return models.map((m) => ({
      name: m.name,
      modelId: m.modelId,
      providerName: m.provider?.name,
      warning: m.warning,
    }));
  }

  /**
   * Builds a TrueForge SDK AgentSpec using the configured model and context-engineering settings.
   */
  public buildPatchPilotAgentSpec(options: {
    modelName: string;
    mcpConnectorName?: string;
  }): TrueForgeApi.AgentSpec {
    if (!options.modelName || options.modelName.trim().length === 0) {
      throw new Error(
        "A configured TrueForge model identifier is required to build the PatchPilot agent spec."
      );
    }

    const template = this.loadAgentTemplate();
    const connectorName = options.mcpConnectorName || DEFAULT_MCP_CONNECTOR_NAME;
    const instructions = template?.manifest.instructions || DEFAULT_INSTRUCTIONS;
    const iterationLimit = template?.manifest.config?.iteration_limit ?? 50;

    return {
      model: {
        name: options.modelName.trim(),
      },
      instructions,
      mcpServers: [
        {
          name: connectorName,
          preload: false, // TrueForge context engineering: deferred MCP tool loading
          enableTools: [...PATCHPILOT_MCP_TOOL_NAMES],
          requireApprovalForTools: [...PATCHPILOT_APPROVAL_REQUIRED_TOOLS],
        },
      ],
      config: {
        iterationLimit,
        contextManagement: {
          compaction: {
            enabled: true,
          },
          largeToolResponse: {
            enabled: true,
          },
        },
      },
    };
  }

  /**
   * Creates or updates the named PatchPilot agent on the TrueForge server.
   */
  public async ensurePatchPilotAgent(
    config: TrueForgeResolvedConfig,
    options: {
      modelName: string;
      agentName?: string;
      mcpConnectorName?: string;
    }
  ): Promise<EnsureAgentResult> {
    const agentName = (options.agentName || config.agentName || DEFAULT_PATCHPILOT_AGENT_NAME).trim();
    const mcpConnectorName =
      options.mcpConnectorName || config.mcpConnectorName || DEFAULT_MCP_CONNECTOR_NAME;
    const modelName = options.modelName.trim();

    const manifest = this.buildPatchPilotAgentSpec({
      modelName,
      mcpConnectorName,
    });

    const template = this.loadAgentTemplate();
    const description =
      template?.description ||
      "PatchPilot VS Code coding agent — safe repository discovery, proposal-only multi-file edits, and disposable overlay verification.";

    const client = this.clientFactory.createClient(config);
    const existingList = await client.agents.list({ limit: 100 });
    const existing = (existingList.data ?? []).find((a) => a.name === agentName);

    let agentId: string;
    let created: boolean;

    if (existing) {
      this.logger.info(
        `Updating existing TrueForge agent "${agentName}" (${existing.id}) with model "${modelName}" and connector "${mcpConnectorName}"...`
      );
      const updated = await client.agents.update(existing.id, {
        description,
        manifest,
      });
      agentId = updated.data.id;
      created = false;
    } else {
      this.logger.info(
        `Creating TrueForge agent "${agentName}" with model "${modelName}" and connector "${mcpConnectorName}"...`
      );
      const createdResp = await client.agents.create({
        name: agentName,
        description,
        manifest,
      });
      agentId = createdResp.data.id;
      created = true;
    }

    return {
      agentId,
      agentName,
      modelName,
      mcpConnectorName,
      created,
      contextEngineering: {
        deferredToolLoading: true,
        compactionEnabled: true,
        largeToolResponseEnabled: true,
        approvalRequiredTools: [...PATCHPILOT_APPROVAL_REQUIRED_TOOLS],
      },
    };
  }
}
