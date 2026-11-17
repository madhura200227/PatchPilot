import assert from "node:assert";
import { TrueForgeClientFactory } from "../../trueforge/clientFactory";
import { TrueForgeResolvedConfig } from "../../config/configuration";

describe("Unit: TrueForgeClientFactory", () => {
  it("should construct TrueForge client with auth: false when no apiKey is provided", () => {
    const factory = new TrueForgeClientFactory();
    const config: TrueForgeResolvedConfig = {
      baseUrl: "http://localhost:8790",
      agentName: "test-agent",
      requestTimeoutSeconds: 30,
    };

    const client = factory.createClient(config);
    assert.ok(client, "Client instance must be created");
    assert.strictEqual(typeof client.sessions.create, "function");
    assert.strictEqual(typeof client.sessions.createTurnStream, "function");
    assert.strictEqual(typeof client.sessions.cancel, "function");
  });

  it("should construct TrueForge client with Bearer auth when apiKey is provided", () => {
    const factory = new TrueForgeClientFactory();
    const config: TrueForgeResolvedConfig = {
      baseUrl: "https://remote-trueforge.internal:8790",
      agentName: "prod-agent",
      requestTimeoutSeconds: 60,
      apiKey: "test-bearer-token-12345",
    };

    const client = factory.createClient(config);
    assert.ok(client, "Client instance must be created with auth token");
  });
});
