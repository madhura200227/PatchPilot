import { TrueForge } from "@truefoundry/trueforge-sdk";
import { TrueForgeResolvedConfig } from "../config/configuration";

export interface ITrueForgeClientFactory {
  createClient(config: TrueForgeResolvedConfig): TrueForge;
}

export class TrueForgeClientFactory implements ITrueForgeClientFactory {
  public createClient(config: TrueForgeResolvedConfig): TrueForge {
    const options: TrueForge.Options = {
      baseUrl: config.baseUrl,
      timeoutInSeconds: config.requestTimeoutSeconds,
      maxRetries: 2,
      // When API token is present, use Bearer authentication; otherwise explicit false for local standalone
      auth: config.apiKey
        ? { token: config.apiKey }
        : false,
    };

    return new TrueForge(options);
  }
}
