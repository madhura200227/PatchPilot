import * as vscode from "vscode";

export const CONFIG_SECTION = "patchpilot.trueforge";
export const TOKEN_SECRET_KEY = "patchpilot.trueforge.token";

export interface TrueForgeResolvedConfig {
  baseUrl: string;
  agentName: string;
  requestTimeoutSeconds: number;
  apiKey?: string;
}

export class ConfigurationManager {
  private secretStorage: vscode.SecretStorage;

  constructor(secretStorage: vscode.SecretStorage) {
    this.secretStorage = secretStorage;
  }

  public async getResolvedConfig(): Promise<TrueForgeResolvedConfig> {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const rawBaseUrl = config.get<string>("baseUrl", "http://localhost:8790");
    const rawAgentName = config.get<string>("agentName", "");
    const rawTimeout = config.get<number>("requestTimeoutSeconds", 30);

    const apiKey = await this.secretStorage.get(TOKEN_SECRET_KEY);

    return {
      baseUrl: rawBaseUrl.trim() || "http://localhost:8790",
      agentName: rawAgentName.trim(),
      requestTimeoutSeconds: rawTimeout > 0 ? rawTimeout : 30,
      apiKey: apiKey && apiKey.trim().length > 0 ? apiKey.trim() : undefined,
    };
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
