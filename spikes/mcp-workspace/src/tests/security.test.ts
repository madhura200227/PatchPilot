import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createWorkspaceMcpServer, RunningMcpServer } from "../server.js";
import {
  readWorkspaceFile,
  writeWorkspaceFile,
  runWorkspaceTests,
  computeSha256,
} from "../tools/workspaceTools.js";
import { SecurityError } from "../security/pathGuard.js";
import { createFixture, resetFixture, DEFAULT_FIXTURE_PATH } from "../fixture/fixtureManager.js";

const TEST_SECRET = "sec-patchpilot-token-test-12345678";

test("Workspace MCP Security Test Suite", async (t) => {
  // Ensure fresh fixture
  createFixture(DEFAULT_FIXTURE_PATH);
  let server: RunningMcpServer;

  // Start local authenticated test server
  server = await createWorkspaceMcpServer({
    port: 0,
    authToken: TEST_SECRET,
    workspaceRoot: DEFAULT_FIXTURE_PATH,
  });

  t.after(async () => {
    await server.stop();
    resetFixture(DEFAULT_FIXTURE_PATH);
  });

  // Snapshot external repository file hash before any tests
  const repoPackageJsonPath = path.resolve(process.cwd(), "package.json");
  const repoHashBefore = computeSha256(fs.readFileSync(repoPackageJsonPath));

  await t.test("1. Rejects '../' path traversal on read", async () => {
    await assert.rejects(
      async () => {
        await readWorkspaceFile(DEFAULT_FIXTURE_PATH, "../../../package.json");
      },
      (err: unknown) => {
        assert.ok(err instanceof SecurityError, "Expected SecurityError");
        assert.match((err as Error).message, /traverses outside/i);
        return true;
      }
    );
  });

  await t.test("2. Rejects '../' path traversal on write", async () => {
    const maliciousTarget = "../escape-attempt.txt";
    const externalFile = path.resolve(DEFAULT_FIXTURE_PATH, maliciousTarget);

    await assert.rejects(
      async () => {
        await writeWorkspaceFile(DEFAULT_FIXTURE_PATH, maliciousTarget, "malicious payload");
      },
      (err: unknown) => {
        assert.ok(err instanceof SecurityError);
        assert.match((err as Error).message, /traverses outside/i);
        return true;
      }
    );

    assert.equal(fs.existsSync(externalFile), false, "External file must not be created");
  });

  await t.test("3. Rejects absolute paths outside the fixture root", async () => {
    const absolutePath = process.platform === "win32" ? "C:\\Windows\\System32\\drivers\\etc\\hosts" : "/etc/passwd";

    await assert.rejects(
      async () => {
        await readWorkspaceFile(DEFAULT_FIXTURE_PATH, absolutePath);
      },
      (err: unknown) => {
        assert.ok(err instanceof SecurityError);
        return true;
      }
    );
  });

  await t.test("4. Rejects Windows drive-letter paths escaping fixture", async () => {
    await assert.rejects(
      async () => {
        await readWorkspaceFile(DEFAULT_FIXTURE_PATH, "D:\\unauthorized\\secret.txt");
      },
      (err: unknown) => {
        assert.ok(err instanceof SecurityError);
        return true;
      }
    );
  });

  await t.test("5. Rejects symlink escape outside workspace root", async () => {
    const outsideTarget = path.join(os.tmpdir(), "outside-secret-file.txt");
    fs.writeFileSync(outsideTarget, "CONFIDENTIAL_DATA");

    const symlinkPath = path.join(DEFAULT_FIXTURE_PATH, "symlink-outside.txt");
    try {
      try {
        fs.symlinkSync(outsideTarget, symlinkPath, "file");
      } catch (e: unknown) {
        console.warn("Symlink creation skipped or requires elevated rights:", (e as Error).message);
        return;
      }

      await assert.rejects(
        async () => {
          await readWorkspaceFile(DEFAULT_FIXTURE_PATH, "symlink-outside.txt");
        },
        (err: unknown) => {
          assert.ok(err instanceof SecurityError);
          assert.match((err as Error).message, /Symlink Escape Denied/i);
          return true;
        }
      );
    } finally {
      if (fs.existsSync(symlinkPath)) fs.unlinkSync(symlinkPath);
      if (fs.existsSync(outsideTarget)) fs.unlinkSync(outsideTarget);
    }
  });

  await t.test("6. Rejects unauthorized HTTP requests (missing Authorization header)", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });

    assert.equal(res.status, 401, "Expected HTTP 401 Unauthorized");
    const body = (await res.json()) as { error: { message: string } };
    assert.match(body.error.message, /Unauthorized/i);
  });

  await t.test("7. Rejects invalid authentication tokens", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer invalid-token-xyz",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });

    assert.equal(res.status, 401, "Expected HTTP 401 Unauthorized for invalid token");
  });

  await t.test("8. Rejects oversized file writes (> 1MB)", async () => {
    const oversizedContent = "A".repeat(1.5 * 1024 * 1024); // 1.5MB

    await assert.rejects(
      async () => {
        await writeWorkspaceFile(DEFAULT_FIXTURE_PATH, "src/oversized.ts", oversizedContent);
      },
      (err: unknown) => {
        assert.match((err as Error).message, /exceeds maximum allowed limit/i);
        return true;
      }
    );
  });

  await t.test("9. Rejects disallowed and executable file extensions", async () => {
    const dangerousExtensions = [".exe", ".bat", ".cmd", ".sh", ".ps1", ".env", ".key"];

    for (const ext of dangerousExtensions) {
      await assert.rejects(
        async () => {
          await writeWorkspaceFile(DEFAULT_FIXTURE_PATH, `payload${ext}`, "dangerous code");
        },
        (err: unknown) => {
          assert.ok(err instanceof SecurityError, `Expected SecurityError for ${ext}`);
          return true;
        }
      );
    }
  });

  await t.test("10. Rejects arbitrary command injection in test runner", async () => {
    const injectionTarget = "tests/calculator.test.mjs; whoami";

    await assert.rejects(
      async () => {
        await runWorkspaceTests(DEFAULT_FIXTURE_PATH, injectionTarget);
      },
      (err: unknown) => {
        assert.ok(err instanceof SecurityError || (err as Error).message.includes("File not found"));
        return true;
      }
    );
  });

  await t.test("11. Enforces test execution timeout on hung processes", async () => {
    const infiniteLoopTest = path.join(DEFAULT_FIXTURE_PATH, "tests", "infinite.test.mjs");
    fs.writeFileSync(
      infiniteLoopTest,
      `import test from "node:test";
test("hangs forever", () => {
  const target = Date.now() + 60000;
  while (Date.now() < target) {
    // Busy loop to block event loop
  }
});
`
    );

    try {
      const result = await runWorkspaceTests(DEFAULT_FIXTURE_PATH, "tests/infinite.test.mjs", 1000);
      assert.equal(result.passed, false, "Hung test must fail due to timeout");
    } finally {
      if (fs.existsSync(infiniteLoopTest)) fs.unlinkSync(infiniteLoopTest);
    }
  });

  await t.test("12. Concurrent writes maintain deterministic integrity", async () => {
    const writePromises = Array.from({ length: 10 }, (_, i) => {
      const fileName = `src/concurrent_${i}.ts`;
      const content = `export const value_${i} = ${i * 42};\n`;
      return writeWorkspaceFile(DEFAULT_FIXTURE_PATH, fileName, content);
    });

    const results = await Promise.all(writePromises);
    assert.equal(results.length, 10);
    for (const r of results) {
      assert.equal(r.success, true);
    }
  });

  await t.test("13. Access containment: PatchPilot repository files remain untouched", async () => {
    const repoHashAfter = computeSha256(fs.readFileSync(repoPackageJsonPath));
    assert.equal(
      repoHashAfter,
      repoHashBefore,
      "CRITICAL WORKSPACE ISOLATION: Host PatchPilot repository files were modified!"
    );
  });
});
