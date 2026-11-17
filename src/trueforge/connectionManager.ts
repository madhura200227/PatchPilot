import { TrueForge } from "@truefoundry/trueforge-sdk";
import { TrueForgeResolvedConfig } from "../config/configuration";
import { ExtensionState, ConnectionStatus } from "../state/extensionState";
import { ILogger } from "../output/logger";
import { ITrueForgeClientFactory } from "./clientFactory";
import { TrueForgeAuthError, TrueForgeConnectionError } from "./errors";

export interface ConnectionCheckResult {
  status: ConnectionStatus;
  serverUrl: string;
  sessionCount: number;
  agentCount: number;
  configuredAgentName: string;
  agentFound: boolean;
  availableAgents: string[];
  message: string;
  error?: string;
}

export class ConnectionManager {
  private clientFactory: ITrueForgeClientFactory;
  private state: ExtensionState;
  private logger: ILogger;
  private lastCheckTimestamp = 0;
  private readonly minCheckIntervalMs = 1000; // Debounce threshold

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
    const now = Date.now();
    if (now - this.lastCheckTimestamp < this.minCheckIntervalMs && this.state.isCheckingConnection) {
      this.logger.debug("Connection check throttled (attempted within debounce interval).");
      return {
        status: this.state.connectionStatus,
        serverUrl: config.baseUrl,
        sessionCount: 0,
        agentCount: 0,
        configuredAgentName: config.agentName,
        agentFound: false,
        availableAgents: [],
        message: "Connection check throttled to avoid tight loops.",
      };
    }

    if (!this.state.acquireCheckConnectionGuard()) {
      this.logger.debug("Connection check already in progress.");
      return {
        status: this.state.connectionStatus,
        serverUrl: config.baseUrl,
        sessionCount: 0,
        agentCount: 0,
        configuredAgentName: config.agentName,
        agentFound: false,
        availableAgents: [],
        message: "Connection check already in progress.",
      };
    }

    this.lastCheckTimestamp = now;
    this.state.setConnectionStatus("CONNECTING", `Connecting to ${config.baseUrl}...`);
    this.logger.info(`Checking TrueForge connection at: ${config.baseUrl}`);

    try {
      const client = this.clientFactory.createClient(config);

      // Real health check: List sessions to verify API responsiveness and authentication
      let sessionCount = 0;
      try {
        const sessionsPage = await client.sessions.list({ limit: 1 });
        sessionCount = sessionsPage.data ? sessionsPage.data.length : 0;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const status = (err as { statusCode?: number })?.statusCode;

        if (status === 401 || status === 403 || errMsg.includes("401") || errMsg.includes("403") || errMsg.includes("Unauthorized")) {
          const authErrorMsg = "TrueForge server requires authentication. Please set your access token via 'PatchPilot: Set TrueForge Access Token'.";
          this.state.setConnectionStatus("AUTH_REQUIRED", authErrorMsg);
          this.logger.error(authErrorMsg, err);
          return {
            status: "AUTH_REQUIRED",
            serverUrl: config.baseUrl,
            sessionCount: 0,
            agentCount: 0,
            configuredAgentName: config.agentName,
            agentFound: false,
            availableAgents: [],
            message: authErrorMsg,
            error: errMsg,
          };
        }

        // Connection refused / network failure / timeout
        const connErrorMsg = `Failed to connect to TrueForge server at ${config.baseUrl}: ${errMsg}`;
        this.state.setConnectionStatus("CONNECTION_FAILED", connErrorMsg);
        this.logger.error(connErrorMsg, err);
        return {
          status: "CONNECTION_FAILED",
          serverUrl: config.baseUrl,
          sessionCount: 0,
          agentCount: 0,
          configuredAgentName: config.agentName,
          agentFound: false,
          availableAgents: [],
          message: connErrorMsg,
          error: errMsg,
        };
      }

      // Query registered agents on TrueForge server
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
        this.logger.warn(`Could not retrieve agent listing: ${agentErr instanceof Error ? agentErr.message : String(agentErr)}`);
      }

      // Validate configured agent name
      let agentFound = false;
      let statusMessage = `Connected to TrueForge at ${config.baseUrl}. Registered agents: ${agentCount}.`;

      if (config.agentName && config.agentName.length > 0) {
        agentFound = availableAgents.includes(config.agentName);
        if (agentFound) {
          statusMessage += ` Agent '${config.agentName}' is ready.`;
        } else {
          statusMessage += ` Warning: Configured agent '${config.agentName}' not found on server. Available agents: [${availableAgents.join(", ")}].`;
          this.logger.warn(statusMessage);
        }
      } else {
        if (availableAgents.length > 0) {
          statusMessage += ` Note: No agentName configured. Available agents: [${availableAgents.join(", ")}].`;
        } else {
          statusMessage += " Note: No agents are registered on this TrueForge server. Please configure an agent on TrueForge.";
        }
      }

      this.state.setConnectionStatus("CONNECTED", statusMessage);
      this.logger.info(statusMessage);

      return {
        status: "CONNECTED",
        serverUrl: config.baseUrl,
        sessionCount,
        agentCount,
        configuredAgentName: config.agentName,
        agentFound,
        availableAgents,
        message: statusMessage,
      };
    } finally {
      this.state.releaseCheckConnectionGuard();
    }
  }
}
