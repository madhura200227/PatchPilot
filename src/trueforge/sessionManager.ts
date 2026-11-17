import { TrueForge, TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { TrueForgeResolvedConfig } from "../config/configuration";
import { ExtensionState } from "../state/extensionState";
import { ILogger } from "../output/logger";
import { ITrueForgeClientFactory } from "./clientFactory";
import { TrueForgeConfigurationError, TrueForgeSessionError } from "./errors";

export interface CreateSessionOptions {
  forceNew?: boolean;
  agentOverride?: TrueForgeApi.CreateSessionRequest["agent"];
}

export class SessionManager {
  private clientFactory: ITrueForgeClientFactory;
  private state: ExtensionState;
  private logger: ILogger;

  constructor(
    clientFactory: ITrueForgeClientFactory,
    state: ExtensionState,
    logger: ILogger
  ) {
    this.clientFactory = clientFactory;
    this.state = state;
    this.logger = logger;
  }

  public async createSession(
    config: TrueForgeResolvedConfig,
    options?: CreateSessionOptions
  ): Promise<string> {
    // If a session is already active and forceNew is false, avoid duplicate session creation
    if (this.state.activeSessionId && !options?.forceNew) {
      this.logger.info(`Using existing active session: ${this.state.activeSessionId}`);
      return this.state.activeSessionId;
    }

    // Duplicate command guard
    if (!this.state.acquireStartSessionGuard()) {
      if (this.state.activeSessionId) {
        return this.state.activeSessionId;
      }
      throw new TrueForgeSessionError("Session creation is already in progress. Please wait.");
    }

    try {
      // Determine agent to bind
      let agentSpec: TrueForgeApi.CreateSessionRequest["agent"];
      if (options?.agentOverride) {
        agentSpec = options.agentOverride;
      } else if (config.agentName && config.agentName.trim().length > 0) {
        agentSpec = { name: config.agentName.trim() };
      } else {
        throw new TrueForgeConfigurationError(
          "TrueForge agent is not configured. Please set 'patchpilot.trueforge.agentName' in VS Code settings to a valid TrueForge agent name.",
          "patchpilot.trueforge.agentName"
        );
      }

      this.logger.info(`Creating TrueForge session with agent: ${JSON.stringify(agentSpec)}...`);
      const client = this.clientFactory.createClient(config);

      const response = await client.sessions.create({
        agent: agentSpec,
        metadata: {
          creator: "PatchPilot-VSCode",
          purpose: "milestone-0-skeleton",
        },
      });

      const sessionId = response.data.id;
      this.state.setActiveSessionId(sessionId);
      this.logger.info(`[PASS] Session successfully created with ID: ${sessionId}`);

      return sessionId;
    } catch (err: unknown) {
      if (err instanceof TrueForgeConfigurationError) {
        this.logger.error(err.message);
        throw err;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to create session: ${errMsg}`, err);
      throw new TrueForgeSessionError(`Failed to create TrueForge session: ${errMsg}`, undefined, err);
    } finally {
      this.state.releaseStartSessionGuard();
    }
  }

  public getActiveSessionId(): string | undefined {
    return this.state.activeSessionId;
  }

  public async deleteSession(config: TrueForgeResolvedConfig, sessionId?: string): Promise<void> {
    const targetId = sessionId || this.state.activeSessionId;
    if (!targetId) {
      this.logger.warn("No active session to delete.");
      return;
    }

    try {
      this.logger.info(`Deleting TrueForge session: ${targetId}...`);
      const client = this.clientFactory.createClient(config);
      await client.sessions.delete(targetId);

      if (this.state.activeSessionId === targetId) {
        this.state.setActiveSessionId(undefined);
      }
      this.logger.info(`[PASS] Session ${targetId} successfully deleted.`);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to delete session ${targetId}: ${errMsg}`, err);
      throw new TrueForgeSessionError(`Failed to delete session: ${errMsg}`, targetId, err);
    }
  }
}
