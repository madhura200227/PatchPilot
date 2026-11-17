import os from "node:os";
import process from "node:process";
import { TrueForge, isEventDelta, mergeEventDelta } from "@truefoundry/trueforge-sdk";

export interface RuntimeDiagnostics {
  system: {
    platform: string;
    arch: string;
    nodeVersion: string;
    v8Version: string;
  };
  sdk: {
    name: string;
    version: string;
    engines: string;
    exports: string[];
    isEventDeltaAvailable: boolean;
    mergeEventDeltaAvailable: boolean;
  };
  server: {
    package: string;
    version: string;
    engines: string;
    defaultPort: number;
    mode: string;
    supportedMcpTransports: string[];
  };
  compatibilityAnalysis: {
    extensionHostNodeVersionStandard: string;
    trueforgeSdkNodeRequirement: string;
    trueforgeServerNodeRequirement: string;
    riskLevel: string;
    architecturalRemediation: string;
  };
}

export function collectRuntimeDiagnostics(): RuntimeDiagnostics {
  return {
    system: {
      platform: `${os.platform()} (${os.release()})`,
      arch: os.arch(),
      nodeVersion: process.version,
      v8Version: process.versions.v8,
    },
    sdk: {
      name: "@truefoundry/trueforge-sdk",
      version: "0.185.0",
      engines: ">=22.0.0",
      exports: [
        "TrueForge",
        "TrueForgeApi",
        "isEventDelta",
        "mergeEventDelta",
        "serialization",
        "sessions",
        "agents",
        "mcpServers",
        "models",
        "sandboxEnvironments",
        "schedules",
        "server",
        "settings",
        "skills",
        "users",
      ],
      isEventDeltaAvailable: typeof isEventDelta === "function",
      mergeEventDeltaAvailable: typeof mergeEventDelta === "function",
    },
    server: {
      package: "@truefoundry/trueforge",
      version: "0.185.1",
      engines: ">=22.14.0",
      defaultPort: 8790,
      mode: "standalone (SQLite, zero Redis/Postgres requirement for local developer testbed)",
      supportedMcpTransports: ["streamable-http", "sse"],
    },
    compatibilityAnalysis: {
      extensionHostNodeVersionStandard: "Node.js v20.x (Electron 30+ bundled in VS Code 1.90-1.95)",
      trueforgeSdkNodeRequirement: "Node.js >= 22.0.0",
      trueforgeServerNodeRequirement: "Node.js >= 22.14.0",
      riskLevel: "HIGH (Node Engine Mismatch if executed in-process inside VS Code Extension Host)",
      architecturalRemediation:
        "TrueForge server must run as an independent out-of-process daemon/container (Node >= 22.14.0). The VS Code extension host must communicate with TrueForge strictly over HTTP/SSE via @truefoundry/trueforge-sdk or isomorphic fetch transport.",
    },
  };
}

async function main() {
  console.log("=== TRUEFORGE RUNTIME & SDK FEASIBILITY DIAGNOSTICS ===");
  const diag = collectRuntimeDiagnostics();
  console.log(JSON.stringify(diag, null, 2));

  console.log("\nVerifying SDK Class Instantiation...");
  try {
    const client = new TrueForge({
      baseUrl: "http://localhost:8790",
      auth: false,
    });
    console.log("[PASS] TrueForge client instantiated successfully.");
    console.log("Client properties available:", Object.getOwnPropertyNames(Object.getPrototypeOf(client)));
  } catch (err) {
    console.error("[FAIL] Error instantiating TrueForge client:", err);
  }
}

if (process.argv[1]?.endsWith("runtime-info.ts") || process.argv[1]?.endsWith("runtime-info.js")) {
  main().catch((err) => {
    console.error("Runtime info inspection failed:", err);
    process.exit(1);
  });
}
