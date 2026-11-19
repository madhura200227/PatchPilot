import * as vscode from "vscode";
import { DEFAULT_CONTEXT_TOKEN_BUDGET } from "../context/tokenBudget";
import { DEFAULT_MCP_CONNECTOR_NAME } from "../workspace/WorkspaceMcpAdapter";

export const CONFIG_SECTION = "patchpilot.trueforge";
export const CONTEXT_CONFIG_SECTION = "patchpilot.context";
export const TOKEN_SECRET_KEY = "patchpilot.trueforge.token";
export const DEFAULT_TRUEFORGE_BASE_URL = "http://127.0.0.1:8790";

export interface TrueForgeResolvedConfig {
  baseUrl: string;
  agentName: string;
  requestTimeoutSeconds: number;
  apiKey?: string;
  modelName?: string;
  mcpConnectorName?: string;
  contextTokenBudget?: number;
}

export class ConfigurationManager {
  private secretStorage: vscode.SecretStorage;

  constructor(secretStorage: vscode.SecretStorage) {
    this.secretStorage = secretStorage;
  }

  public async getResolvedConfig(): Promise<TrueForgeResolvedConfig> {
    const tfConfig = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const ctxConfig = vscode.workspace.getConfiguration(CONTEXT_CONFIG_SECTION);

    const rawBaseUrl = tfConfig.get<string>("baseUrl", DEFAULT_TRUEFORGE_BASE_URL);
    const rawAgentName = tfConfig.get<string>("agentName", "");
    const rawTimeout = tfConfig.get<number>("requestTimeoutSeconds", 30);
    const rawModelName = tfConfig.get<string>("modelName", "");
    const rawConnectorName = tfConfig.get<string>("mcpConnectorName", DEFAULT_MCP_CONNECTOR_NAME);
    const rawBudget = ctxConfig.get<number>("tokenBudget", DEFAULT_CONTEXT_TOKEN_BUDGET);

    const apiKey = await this.secretStorage.get(TOKEN_SECRET_KEY);

    return {
      baseUrl: (rawBaseUrl || "").trim() || DEFAULT_TRUEFORGE_BASE_URL,
      agentName: (rawAgentName || "").trim(),
      requestTimeoutSeconds: typeof rawTimeout === "number" && rawTimeout > 0 ? rawTimeout : 30,
      apiKey: apiKey && apiKey.trim().length > 0 ? apiKey.trim() : undefined,
      modelName: (rawModelName || "").trim() || undefined,
      mcpConnectorName: (rawConnectorName || "").trim() || DEFAULT_MCP_CONNECTOR_NAME,
      contextTokenBudget:
        typeof rawBudget === "number" && rawBudget >= 1000
          ? Math.floor(rawBudget)
          : DEFAULT_CONTEXT_TOKEN_BUDGET,
    };
  }

  public async updateSetting(
    section: typeof CONFIG_SECTION | typeof CONTEXT_CONFIG_SECTION,
    key: string,
    value: unknown
  ): Promise<void> {
    const cfg = vscode.workspace.getConfiguration(section);
    await cfg.update(key, value, vscode.ConfigurationTarget.Global);
  }

  public async setApiToken(token: string): Promise<void> {
    const trimmed = token.trim();
    if (trimmed.length > 0) {
      await this.secretStorage.store(TOKEN_SECRET_KEY, trimmed);
    } else {
      await this.clearApiToken();
    }
  }

  public async clearApiToken(): Promise<void> {
    await this.secretStorage.delete(TOKEN_SECRET_KEY);
  }

  public async hasApiToken(): Promise<boolean> {
    const token = await this.secretStorage.get(TOKEN_SECRET_KEY);
    return Boolean(token && token.trim().length > 0);
  }
}
