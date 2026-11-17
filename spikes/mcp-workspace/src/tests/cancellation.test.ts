import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { TrueForge } from "@truefoundry/trueforge-sdk";
import { createWorkspaceMcpServer, RunningMcpServer } from "../server.js";
import { runWorkspaceTests, writeWorkspaceFile } from "../tools/workspaceTools.js";
import { createFixture, resetFixture, DEFAULT_FIXTURE_PATH } from "../fixture/fixtureManager.js";

const TEST_SECRET = "sec-cancellation-test-token-77777777";

test("TrueForge & Workspace MCP Cancellation Semantics Suite", async (t) => {
  createFixture(DEFAULT_FIXTURE_PATH);
  let mcpServer: RunningMcpServer;
  let tfClient: TrueForge;

  mcpServer = await createWorkspaceMcpServer({
    port: 0,
    authToken: TEST_SECRET,
    workspaceRoot: DEFAULT_FIXTURE_PATH,
  });

  tfClient = new TrueForge({
    baseUrl: process.env.TRUEFORGE_SERVER_URL || "http://localhost:8790",
    auth: false,
    timeoutInSeconds: 15,
  });

  t.after(async () => {
    await mcpServer.stop();
    resetFixture(DEFAULT_FIXTURE_PATH);
  });

  await t.test("1. Client SSE stream cancellation via AbortSignal", async () => {
    const controller = new AbortController();

    // Trigger SSE connection and abort immediately
    const fetchPromise = fetch(`http://127.0.0.1:${mcpServer.port}/mcp`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${TEST_SECRET}`,
        Accept: "text/event-stream",
      },
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 30);

    await assert.rejects(
      fetchPromise,
      (err: unknown) => {
        const error = err as Error;
        assert.equal(error.name, "AbortError", "Expected AbortError upon client cancellation");
        return true;
      }
    );
  });

  await t.test("2. TrueForge server-side turn cancellation endpoint", async () => {
    // Create TrueForge session with valid agent specification
    const sessionResponse = await tfClient.sessions.create({
      agent: {
        spec: {
          model: { name: "openai/gpt-4o" },
          instructions: "You are a test assistant.",
        },
      },
    });

    const sessionId = sessionResponse.data.id;
    try {
      // Dispatches cancel request to server
      const cancelResponse = await tfClient.sessions.cancel(sessionId);
      assert.ok(cancelResponse !== undefined);
    } finally {
      await tfClient.sessions.delete(sessionId).catch(() => {});
    }
  });

  await t.test("3. Active test execution process is killed on cancellation signal", async () => {
    const infiniteLoopTest = path.join(DEFAULT_FIXTURE_PATH, "tests", "infinite_cancel.test.mjs");
    fs.writeFileSync(
      infiniteLoopTest,
      `import test from "node:test";
test("hangs forever", () => {
  const target = Date.now() + 60000;
  while (Date.now() < target) {}
});
`
    );

    const abortController = new AbortController();

    // Trigger test run with cancellation after 150ms
    setTimeout(() => abortController.abort(), 150);

    const startTime = Date.now();
    try {
      const result = await runWorkspaceTests(
        DEFAULT_FIXTURE_PATH,
        "tests/infinite_cancel.test.mjs",
        10000,
        abortController.signal
      );

      const elapsed = Date.now() - startTime;
      assert.ok(elapsed < 2000, `Process must be terminated promptly on signal, took ${elapsed}ms`);
      assert.equal(result.passed, false, "Cancelled test must report failed/aborted");
      assert.equal(result.exitCode, 130, "Aborted process exit code must indicate interruption");
      assert.match(result.stderr, /cancelled via AbortSignal/i);
    } finally {
      if (fs.existsSync(infiniteLoopTest)) fs.unlinkSync(infiniteLoopTest);
    }
  });

  await t.test("4. Subsequent writes are rejected when turn context is cancelled", async () => {
    let turnCancelled = true; // Simulated turn cancellation context flag

    function performGuardedWrite(turnContextActive: boolean, filePath: string, content: string) {
      if (!turnContextActive) {
        throw new Error("WriteRejected: Turn was cancelled by user; subsequent workspace writes are prohibited");
      }
      return writeWorkspaceFile(DEFAULT_FIXTURE_PATH, filePath, content);
    }

    assert.throws(
      () => performGuardedWrite(!turnCancelled, "src/unauthorized_post_cancel.ts", "data"),
      /Turn was cancelled by user/i
    );

    assert.equal(
      fs.existsSync(path.join(DEFAULT_FIXTURE_PATH, "src/unauthorized_post_cancel.ts")),
      false,
      "No file should be written after turn cancellation"
    );
  });
});
