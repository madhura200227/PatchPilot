import { TrueForgeResolvedConfig } from "../config/configuration";
import { ILogger } from "../output/logger";
import { sanitizeSecretText } from "../security/secretFilter";
import { ConnectionStatus, ExtensionState } from "../state/extensionState";
import { DEFAULT_MCP_CONNECTOR_NAME } from "../workspace/WorkspaceMcpAdapter";
import { ITrueForgeClientFactory } from "./clientFactory";

export type TrueForgeDiagnosticState =
  | "CONNECTED"
  | "SERVER_NOT_RUNNING"
  | "UNSUPPORTED_SERVER_VERSION"
  | "MODEL_NOT_CONFIGURED"
  | "AUTH_REQUIRED"
  | "MCP_CONNECTOR_NOT_REGISTERED"
  | "AGENT_NOT_CONFIGURED"
  | "REQUEST_FAILED";

export interface ModelSummary {
  name: string;
  modelId: string;
  providerName?: string;
}

export interface ConnectionCheckResult {
  status: ConnectionStatus;
  diagnosticState: TrueForgeDiagnosticState;
  serverUrl: string;
  sessionCount: number;
  agentCount: number;
  configuredAgentName: string;
  agentFound: boolean;
  availableAgents: string[];
  availableModels: ModelSummary[];
  mcpConnectorName: string;
  mcpConnectorRegistered: boolean;
  mcpDiscoveredTools: string[];
  message: string;
  error?: string;
}

function classifyNetworkOrHttpError(err: unknown): {
  status: ConnectionStatus;
  diagnosticState: TrueForgeDiagnosticState;
  sanitizedMsg: string;
} {
  const rawMsg = err instanceof Error ? err.message : String(err);
  const sanitizedMsg = sanitizeSecretText(rawMsg);
  const statusCode = (err as { statusCode?: number })?.statusCode;

  if (
    statusCode === 401 ||
    statusCode === 403 ||
    sanitizedMsg.includes("401") ||
    sanitizedMsg.includes("403") ||
    sanitizedMsg.toLowerCase().includes("unauthorized")
  ) {
    return { status: "AUTH_REQUIRED", diagnosticState: "AUTH_REQUIRED", sanitizedMsg };
  }

  if (
    sanitizedMsg.includes("ECONNREFUSED") ||
    sanitizedMsg.includes("ENOTFOUND") ||
    sanitizedMsg.includes("EHOSTUNREACH") ||
    sanitizedMsg.includes("fetch failed")
  ) {
    return { status: "CONNECTION_FAILED", diagnosticState: "SERVER_NOT_RUNNING", sanitizedMsg };
  }

  if (statusCode === 404 || statusCode === 405 || statusCode === 501) {
    return {
      status: "CONNECTION_FAILED",
      diagnosticState: "UNSUPPORTED_SERVER_VERSION",
      sanitizedMsg,
    };
  }

  return { status: "CONNECTION_FAILED", diagnosticState: "REQUEST_FAILED", sanitizedMsg };
}

export class ConnectionManager {
  private clientFactory: ITrueForgeClientFactory;
  private state: ExtensionState;
  private logger: ILogger;
  private lastCheckTimestamp = 0;
  private readonly minCheckIntervalMs = 1000;

  constructor(
    clientFactory: ITrueForgeClientFactory,
    state: ExtensionState,
    logger: ILogger
  ) {
    this.clientFactory = clientFactory;
    this.state = state;
    this.logger = logger;
  }

  public async checkConnection(config: TrueForgeResolvedConfig): Promise<ConnectionCheckResult> {
    const connectorName = config.mcpConnectorName || DEFAULT_MCP_CONNECTOR_NAME;
    const now = Date.now();
    if (now - this.lastCheckTimestamp < this.minCheckIntervalMs && this.state.isCheckingConnection) {
      this.logger.debug("Connection check throttled (attempted within debounce interval).");
      return {
        status: this.state.connectionStatus,
        diagnosticState: "REQUEST_FAILED",
        serverUrl: config.baseUrl,
        sessionCount: 0,
        agentCount: 0,
        configuredAgentName: config.agentName,
        agentFound: false,
        availableAgents: [],
        availableModels: [],
        mcpConnectorName: connectorName,
        mcpConnectorRegistered: false,
        mcpDiscoveredTools: [],
        message: "Connection check throttled to avoid tight loops.",
      };
    }

    if (!this.state.acquireCheckConnectionGuard()) {
      this.logger.debug("Connection check already in progress.");
      return {
        status: this.state.connectionStatus,
        diagnosticState: "REQUEST_FAILED",
        serverUrl: config.baseUrl,
        sessionCount: 0,
        agentCount: 0,
        configuredAgentName: config.agentName,
        agentFound: false,
        availableAgents: [],
        availableModels: [],
        mcpConnectorName: connectorName,
        mcpConnectorRegistered: false,
        mcpDiscoveredTools: [],
        message: "Connection check already in progress.",
      };
    }

    this.lastCheckTimestamp = now;
    this.state.setConnectionStatus("CONNECTING", `Connecting to ${config.baseUrl}...`);
    this.logger.info(`Checking TrueForge connection at: ${config.baseUrl}`);

    try {
      const client = this.clientFactory.createClient(config);

      // 1. Verify API reachability & auth via sessions.list
      let sessionCount = 0;
      try {
        const sessionsPage = await client.sessions.list({ limit: 1 });
        sessionCount = sessionsPage.data ? sessionsPage.data.length : 0;
      } catch (err: unknown) {
        const classified = classifyNetworkOrHttpError(err);
        if (classified.status === "AUTH_REQUIRED") {
          const authErrorMsg =
            "TrueForge server requires authentication. Please set your access token via 'PatchPilot: Set TrueForge Access Token'.";
          this.state.setConnectionStatus("AUTH_REQUIRED", authErrorMsg);
          this.logger.error(authErrorMsg);
          return {
            status: "AUTH_REQUIRED",
            diagnosticState: "AUTH_REQUIRED",
            serverUrl: config.baseUrl,
            sessionCount: 0,
            agentCount: 0,
            configuredAgentName: config.agentName,
            agentFound: false,
            availableAgents: [],
            availableModels: [],
            mcpConnectorName: connectorName,
            mcpConnectorRegistered: false,
            mcpDiscoveredTools: [],
            message: authErrorMsg,
            error: classified.sanitizedMsg,
          };
        }

        const connErrorMsg =
          classified.diagnosticState === "SERVER_NOT_RUNNING"
            ? `Failed to connect to TrueForge server at ${config.baseUrl}: server is not running (${classified.sanitizedMsg}). Start it with "npx @truefoundry/trueforge@latest".`
            : classified.diagnosticState === "UNSUPPORTED_SERVER_VERSION"
              ? `Failed to connect to TrueForge server at ${config.baseUrl}: unsupported server version or API path (${classified.sanitizedMsg}).`
              : `Failed to connect to TrueForge server at ${config.baseUrl}: ${classified.sanitizedMsg}`;

        this.state.setConnectionStatus("CONNECTION_FAILED", connErrorMsg);
        this.logger.error(connErrorMsg);
        return {
          status: "CONNECTION_FAILED",
          diagnosticState: classified.diagnosticState,
          serverUrl: config.baseUrl,
          sessionCount: 0,
          agentCount: 0,
          configuredAgentName: config.agentName,
          agentFound: false,
          availableAgents: [],
          availableModels: [],
          mcpConnectorName: connectorName,
          mcpConnectorRegistered: false,
          mcpDiscoveredTools: [],
          message: connErrorMsg,
          error: classified.sanitizedMsg,
        };
      }

      // 2. Query registered agents
      let agentCount = 0;
      const availableAgents: string[] = [];
      try {
        const agentsPage = await client.agents.list({ limit: 50 });
        if (agentsPage.data) {
          agentCount = agentsPage.data.length;
          for (const a of agentsPage.data) {
            if (a.name) {
              availableAgents.push(a.name);
            }
          }
        }
      } catch (agentErr: unknown) {
        this.logger.warn(
          `Could not retrieve agent listing: ${sanitizeSecretText(agentErr instanceof Error ? agentErr.message : String(agentErr))}`
        );
      }

      // 3. Query configured models (do NOT treat TCP connection as proof a model is configured!)
      let modelsChecked = false;
      const availableModels: ModelSummary[] = [];
      if (client.models && typeof client.models.list === "function") {
        try {
          const modelsResp = await client.models.list();
          modelsChecked = true;
          for (const m of modelsResp.data ?? []) {
            availableModels.push({
              name: m.name,
              modelId: m.modelId,
              providerName: m.provider?.name,
            });
          }
        } catch (modelErr: unknown) {
          this.logger.warn(
            `Could not query TrueForge models catalogue: ${sanitizeSecretText(modelErr instanceof Error ? modelErr.message : String(modelErr))}`
          );
        }
      }

      // 4. Query MCP connectors & discovered tools
      let mcpChecked = false;
      let mcpConnectorRegistered = false;
      let mcpDiscoveredTools: string[] = [];
      if (client.mcpServers && typeof client.mcpServers.list === "function") {
        try {
          const mcpResp = await client.mcpServers.list();
          mcpChecked = true;
          const found = (mcpResp.data ?? []).find((s) => s.name === connectorName);
          if (found) {
            mcpConnectorRegistered = true;
            if (typeof client.mcpServers.listTools === "function") {
              try {
                const toolsResp = await client.mcpServers.listTools(connectorName);
                mcpDiscoveredTools = (toolsResp.data ?? [])
                  .map((t) => (typeof t.name === "string" ? t.name : ""))
                  .filter((n): n is string => n.length > 0)
                  .sort();
              } catch {
                // Connector exists but tool discovery may fail if MCP server is not started yet
              }
            }
          }
        } catch (mcpErr: unknown) {
          this.logger.warn(
            `Could not query TrueForge MCP connectors: ${sanitizeSecretText(mcpErr instanceof Error ? mcpErr.message : String(mcpErr))}`
          );
        }
      }

      // 5. Evaluate rich diagnostic state
      const agentFound =
        Boolean(config.agentName && config.agentName.length > 0) &&
        availableAgents.includes(config.agentName);

      let diagnosticState: TrueForgeDiagnosticState = "CONNECTED";
      let statusMessage = `Connected to TrueForge at ${config.baseUrl}. Registered agents: ${agentCount}.`;

      if (modelsChecked && availableModels.length === 0) {
        diagnosticState = "MODEL_NOT_CONFIGURED";
        statusMessage += ` Model not configured: open ${config.baseUrl} Settings -> Model Providers to configure a provider and model.`;
      } else if (mcpChecked && !mcpConnectorRegistered) {
        diagnosticState = "MCP_CONNECTOR_NOT_REGISTERED";
        statusMessage += ` MCP connector '${connectorName}' is not registered yet. Run 'PatchPilot: Configure TrueForge' to start & register it.`;
      } else if (!config.agentName || !agentFound) {
        diagnosticState = "AGENT_NOT_CONFIGURED";
        if (config.agentName) {
          statusMessage += ` Warning: Configured agent '${config.agentName}' not found on server. Available agents: [${availableAgents.join(", ")}].`;
          this.logger.warn(statusMessage);
        } else if (availableAgents.length > 0) {
          statusMessage += ` Note: No agentName configured. Available agents: [${availableAgents.join(", ")}].`;
        } else {
          statusMessage +=
            " Note: No agents are registered on this TrueForge server. Run 'PatchPilot: Configure TrueForge' to create the PatchPilot agent.";
        }
      } else {
        statusMessage += ` Agent '${config.agentName}' is ready.`;
        if (availableModels.length > 0) {
          statusMessage += ` Configured models: ${availableModels.length}.`;
        }
      }

      this.state.setConnectionStatus("CONNECTED", statusMessage);
      this.logger.info(statusMessage);

      return {
        status: "CONNECTED",
        diagnosticState,
        serverUrl: config.baseUrl,
        sessionCount,
        agentCount,
        configuredAgentName: config.agentName,
        agentFound,
        availableAgents,
        availableModels,
        mcpConnectorName: connectorName,
        mcpConnectorRegistered,
        mcpDiscoveredTools,
        message: statusMessage,
      };
    } finally {
      this.state.releaseCheckConnectionGuard();
    }
  }
}
