import process from "node:process";
import dotenv from "dotenv";
import { TrueForge } from "@truefoundry/trueforge-sdk";

// Load environment variables from .env if present
dotenv.config();

export interface TrueForgeClientConfig {
  baseUrl: string;
  apiKey?: string;
  timeoutInSeconds?: number;
  maxRetries?: number;
}

export function getClientConfigFromEnv(): TrueForgeClientConfig {
  const baseUrl = process.env.TRUEFORGE_SERVER_URL || "http://localhost:8790";
  const apiKey = process.env.TRUEFORGE_API_KEY;
  const timeoutInSeconds = process.env.TRUEFORGE_TIMEOUT_SECONDS
    ? Number.parseInt(process.env.TRUEFORGE_TIMEOUT_SECONDS, 10)
    : 30;

  return {
    baseUrl,
    apiKey: apiKey && apiKey.trim().length > 0 ? apiKey.trim() : undefined,
    timeoutInSeconds,
    maxRetries: 2,
  };
}

export function createTrueForgeClient(config?: Partial<TrueForgeClientConfig>): TrueForge {
  const resolved = { ...getClientConfigFromEnv(), ...config };

  const clientOptions: TrueForge.Options = {
    baseUrl: resolved.baseUrl,
    timeoutInSeconds: resolved.timeoutInSeconds,
    maxRetries: resolved.maxRetries,
    // When no API key is provided for local standalone mode, explicitly disable auth
    auth: resolved.apiKey
      ? { token: resolved.apiKey }
      : false,
  };

  return new TrueForge(clientOptions);
}

export async function checkServerHealth(client: TrueForge): Promise<{
  connected: boolean;
  serverUrl: string;
  sessionCount: number;
  agentCount: number;
  error?: string;
}> {
  const config = getClientConfigFromEnv();
  try {
    const sessions = await client.sessions.list({ limit: 10 });
    const agents = await client.agents.list({ limit: 10 });

    return {
      connected: true,
      serverUrl: config.baseUrl,
      sessionCount: sessions.data ? sessions.data.length : 0,
      agentCount: agents.data ? agents.data.length : 0,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      connected: false,
      serverUrl: config.baseUrl,
      sessionCount: 0,
      agentCount: 0,
      error: message,
    };
  }
}

async function main() {
  console.log("=== TRUEFORGE SDK CLIENT CONNECTION TEST ===");
  const config = getClientConfigFromEnv();
  console.log(`Connecting to TrueForge server at: ${config.baseUrl}`);
  console.log(`Authentication: ${config.apiKey ? "Bearer token configured" : "Local Standalone (auth: false)"}`);

  const client = createTrueForgeClient();
  const health = await checkServerHealth(client);

  if (health.connected) {
    console.log("[PASS] Server connection established successfully!");
    console.log(`Active Sessions on Server: ${health.sessionCount}`);
    console.log(`Registered Agents on Server: ${health.agentCount}`);
  } else {
    console.error("[FAIL] Could not connect to TrueForge server.");
    console.error(`Error details: ${health.error}`);
    process.exit(1);
  }
}

if (process.argv[1]?.endsWith("client.ts") || process.argv[1]?.endsWith("client.js")) {
  main().catch((err) => {
    console.error("Client test failed:", err);
    process.exit(1);
  });
}
