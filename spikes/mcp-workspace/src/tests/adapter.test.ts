import test from "node:test";
import * as assert from "node:assert/strict";
import { WorkspaceMcpAdapter } from "../adapter/WorkspaceMcpAdapter.js";
import { createFixture, resetFixture, DEFAULT_FIXTURE_PATH } from "../fixture/fixtureManager.js";

test("PatchPilot Extension Isolated MCP Adapter Test Suite", async (t) => {
  createFixture(DEFAULT_FIXTURE_PATH);
  const adapter = new WorkspaceMcpAdapter();

  t.after(async () => {
    await adapter.stop();
    resetFixture(DEFAULT_FIXTURE_PATH);
  });

  await t.test("1. Initial state is stopped with no credentials exposed", () => {
    assert.equal(adapter.getState(), "stopped");
    const status = adapter.getStatus();
    assert.equal(status.state, "stopped");
    assert.equal(status.port, null);
    assert.equal(status.url, null);
    assert.equal(status.authTokenRedacted, null);
  });

  await t.test("2. Starts server and generates cryptographic authentication token", async () => {
    const status = await adapter.start({
      workspaceRoot: DEFAULT_FIXTURE_PATH,
    });

    assert.equal(adapter.getState(), "running");
    assert.equal(status.state, "running");
    assert.ok(typeof status.port === "number" && status.port > 0);
    assert.ok(status.url && status.url.startsWith("http://127.0.0.1:"));
    assert.ok(status.authTokenRedacted && status.authTokenRedacted.includes("..."));

    // Full token accessible only via secure getter
    const fullToken = adapter.getAuthToken();
    assert.ok(fullToken.startsWith("sec-patchpilot-"));
    assert.ok(fullToken.length > 32);
  });

  await t.test("3. checkHealth probes local loopback health endpoint", async () => {
    const health = await adapter.checkHealth();
    assert.equal(health.healthy, true);
    assert.equal(health.statusCode, 200);
    assert.ok(health.latencyMs >= 0 && health.latencyMs < 500);
    assert.equal(health.details?.status, "healthy");
    assert.equal(health.details?.boundHost, "127.0.0.1");
  });

  await t.test("4. Rejects starting a second instance without stopping first", async () => {
    await assert.rejects(
      async () => {
        await adapter.start({ workspaceRoot: DEFAULT_FIXTURE_PATH });
      },
      /already running/i
    );
  });

  await t.test("5. Stops server gracefully and cleans up state", async () => {
    await adapter.stop();
    assert.equal(adapter.getState(), "stopped");

    const health = await adapter.checkHealth();
    assert.equal(health.healthy, false);
    assert.equal(health.error, "Server is not running");

    assert.throws(() => adapter.getAuthToken(), /not running/i);
    assert.throws(() => adapter.getEndpointUrl(), /not running/i);
  });
});
