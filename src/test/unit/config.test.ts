import assert from "node:assert";
import { ConfigurationManager, TOKEN_SECRET_KEY } from "../../config/configuration";
import { MockSecretStorage } from "../testHelpers";

describe("Unit: ConfigurationManager & SecretStorage", () => {
  it("should securely store and retrieve TrueForge API token in SecretStorage", async () => {
    const secrets = new MockSecretStorage();
    const configManager = new ConfigurationManager(secrets);

    assert.strictEqual(await configManager.hasApiToken(), false);

    await configManager.setApiToken("secret-token-xyz");
    assert.strictEqual(await configManager.hasApiToken(), true);
    assert.strictEqual(await secrets.get(TOKEN_SECRET_KEY), "secret-token-xyz");

    await configManager.clearApiToken();
    assert.strictEqual(await configManager.hasApiToken(), false);
    assert.strictEqual(await secrets.get(TOKEN_SECRET_KEY), undefined);
  });

  it("should resolve configuration with defaults when settings are empty", async () => {
    const secrets = new MockSecretStorage();
    const configManager = new ConfigurationManager(secrets);

    const resolved = await configManager.getResolvedConfig();
    assert.strictEqual(resolved.baseUrl, "http://localhost:8790");
    assert.strictEqual(resolved.agentName, "");
    assert.strictEqual(resolved.requestTimeoutSeconds, 30);
    assert.strictEqual(resolved.apiKey, undefined);
  });

  it("should resolve configuration with token from SecretStorage", async () => {
    const secrets = new MockSecretStorage();
    await secrets.store(TOKEN_SECRET_KEY, "bearer-secret-token");
    const configManager = new ConfigurationManager(secrets);

    const resolved = await configManager.getResolvedConfig();
    assert.strictEqual(resolved.apiKey, "bearer-secret-token");
  });
});
