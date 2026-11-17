import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createWorkspaceMcpServer } from "../server.js";
import {
  readWorkspaceFile,
  writeWorkspaceFile,
  runWorkspaceTests,
  getWorkspaceStatus,
} from "../tools/workspaceTools.js";
import {
  createFixture,
  resetFixture,
  computeDirectoryHashes,
  computeSha256,
  DEFAULT_FIXTURE_PATH,
} from "../fixture/fixtureManager.js";
import { SecurityError } from "../security/pathGuard.js";

const TEST_SECRET = "sec-workspace-isolation-test-99999999";

function scanDirectoryHashes(rootDir: string): Record<string, string> {
  const result: Record<string, string> = {};
  function walk(current: string) {
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      if (item.name === "node_modules" || item.name === ".git" || item.name === "dist") continue;
      const full = path.join(current, item.name);
      if (item.isDirectory()) {
        walk(full);
      } else if (item.isFile()) {
        const rel = path.relative(rootDir, full).replace(/\\/g, "/");
        result[rel] = computeSha256(fs.readFileSync(full));
      }
    }
  }
  walk(rootDir);
  return result;
}

test("Workspace Isolation & Repository Protection Proof", async (t) => {
  // 1. Establish initial deterministic fixture
  const initialManifest = createFixture(DEFAULT_FIXTURE_PATH);
  const hostRepoRoot = path.resolve(process.cwd());

  // 2. Snapshot host PatchPilot repository files and hashes
  const hostHashesBefore = scanDirectoryHashes(hostRepoRoot);
  assert.ok(Object.keys(hostHashesBefore).length > 10, "Host repository must contain files");
  assert.ok(hostHashesBefore["package.json"], "Host package.json must be present");
  assert.ok(hostHashesBefore["src/extension.ts"], "Host src/extension.ts must be present");

  const server = await createWorkspaceMcpServer({
    port: 0,
    authToken: TEST_SECRET,
    workspaceRoot: DEFAULT_FIXTURE_PATH,
  });

  t.after(async () => {
    await server.stop();
    resetFixture(DEFAULT_FIXTURE_PATH);
  });

  await t.test("1. Read operations are strictly confined to fixture", async () => {
    // Permitted file in fixture
    const fixtureFile = await readWorkspaceFile(DEFAULT_FIXTURE_PATH, "src/calculator.ts");
    assert.ok(fixtureFile.content.includes("export function add"));

    // Attempted read of host repository extension.ts
    await assert.rejects(
      async () => {
        await readWorkspaceFile(DEFAULT_FIXTURE_PATH, path.join(hostRepoRoot, "src/extension.ts"));
      },
      (err: unknown) => {
        assert.ok(err instanceof SecurityError);
        assert.match((err as Error).message, /traverses outside/i);
        return true;
      }
    );
  });

  await t.test("2. Write operations cannot mutate host repository files", async () => {
    // Permitted write in fixture
    const writeResult = await writeWorkspaceFile(
      DEFAULT_FIXTURE_PATH,
      "src/new_isolated_file.ts",
      "export const ISOLATED = true;\n"
    );
    assert.equal(writeResult.success, true);
    assert.ok(fs.existsSync(path.join(DEFAULT_FIXTURE_PATH, "src/new_isolated_file.ts")));

    // Attempted write targeting host repository extension.ts
    await assert.rejects(
      async () => {
        await writeWorkspaceFile(
          DEFAULT_FIXTURE_PATH,
          path.join(hostRepoRoot, "src/extension.ts"),
          "// MALICIOUS MUTATION ATTEMPT"
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof SecurityError);
        return true;
      }
    );
  });

  await t.test("3. Test execution runs inside fixture and cannot touch host", async () => {
    const testResult = await runWorkspaceTests(DEFAULT_FIXTURE_PATH);
    // Deliberate failure in fixture
    assert.equal(testResult.passed, false);
    assert.notEqual(testResult.exitCode, 0);
  });

  await t.test("4. Fixture state reports changes without leaking host files", async () => {
    const status = await getWorkspaceStatus(DEFAULT_FIXTURE_PATH);
    assert.equal(status.clean, false);
    // Fixture reports untracked new file
    assert.ok(status.untrackedFiles.some((f) => f.includes("new_isolated_file.ts")));

    // Must not report any files from host repository
    for (const f of [...status.modifiedFiles, ...status.untrackedFiles]) {
      assert.ok(!f.includes("spikes/mcp-workspace"), "Host repo path leaked into fixture status!");
      assert.ok(!f.includes("package-lock.json"), "Host repo path leaked into fixture status!");
    }
  });

  await t.test("5. Fixture is cleanly resettable to initial git state", async () => {
    resetFixture(DEFAULT_FIXTURE_PATH);

    // Untracked new file must be removed
    assert.equal(fs.existsSync(path.join(DEFAULT_FIXTURE_PATH, "src/new_isolated_file.ts")), false);

    // Git status must return to clean
    const statusPostReset = await getWorkspaceStatus(DEFAULT_FIXTURE_PATH);
    assert.equal(statusPostReset.clean, true);

    // Content hashes in fixture match initial manifest
    const fixtureHashesPostReset = computeDirectoryHashes(DEFAULT_FIXTURE_PATH);
    for (const [relPath, info] of Object.entries(initialManifest.files)) {
      assert.equal(
        fixtureHashesPostReset[relPath]?.sha256,
        info.sha256,
        `File ${relPath} hash mismatch post-reset`
      );
    }
  });

  await t.test("6. CRITICAL PROOF: Host PatchPilot repository files are 100% untouched", () => {
    const hostHashesAfter = scanDirectoryHashes(hostRepoRoot);

    assert.equal(
      Object.keys(hostHashesAfter).length,
      Object.keys(hostHashesBefore).length,
      "Host repository file count changed!"
    );

    for (const [relPath, beforeHash] of Object.entries(hostHashesBefore)) {
      const afterHash = hostHashesAfter[relPath];
      assert.equal(
        afterHash,
        beforeHash,
        `Host repository file "${relPath}" was unexpectedly mutated!`
      );
    }
  });
});
