import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolveSafeWorkspacePath,
  safeReadWorkspaceTextFile,
  isBinaryBuffer,
  SecurityError,
} from "../../security/pathGuard";
import {
  sanitizeSecretText,
  isSensitiveFilePath,
  sanitizeProcessEnv,
} from "../../security/secretFilter";
import {
  validateCommandSpec,
  executeSafeWorkspaceCommand,
} from "../../security/commandPolicy";

describe("Unit: Production Security Layer (PathGuard, SecretFilter, CommandPolicy)", () => {
  let tmpRoot: string;

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "patchpilot-sec-test-"));
    fs.mkdirSync(path.join(tmpRoot, "src"), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, "tests"), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, ".git"), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, "src", "app.py"), "def hello():\n    return 'world'\n", "utf8");
    fs.writeFileSync(
      path.join(tmpRoot, "tests", "sample.test.mjs"),
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('ok', () => assert.equal(1 + 1, 2));\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(tmpRoot, "tests", "slow.test.mjs"),
      "import test from 'node:test';\ntest('slow', async () => { await new Promise(r => setTimeout(r, 10000)); });\n",
      "utf8"
    );
    fs.writeFileSync(path.join(tmpRoot, ".env"), "OPENAI_API_KEY=sk-secret123456789\n", "utf8");
    fs.writeFileSync(path.join(tmpRoot, ".npmrc"), "//registry.npmjs.org/:_authToken=secret\n", "utf8");
    fs.writeFileSync(path.join(tmpRoot, ".bashrc"), "export FOO=bar\n", "utf8");
    fs.writeFileSync(path.join(tmpRoot, ".gitignore"), "dist/\n", "utf8");
    fs.writeFileSync(path.join(tmpRoot, "src", "bin.txt"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
  });

  after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe("SecretFilter", () => {
    it("should redact bearer tokens, API keys, and custom runtime secrets", () => {
      const dynamicToken = "sec-patchpilot-998877665544332211";
      const input = `Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig sk-proj-abcdef12345678 ${dynamicToken} AIzaSyA123456789012345678901`;
      const sanitized = sanitizeSecretText(input, [dynamicToken]);

      assert.ok(!sanitized.includes("eyJhbGciOiJIUzI1NiJ9"));
      assert.ok(!sanitized.includes("sk-proj-abcdef12345678"));
      assert.ok(!sanitized.includes(dynamicToken));
      assert.ok(!sanitized.includes("AIzaSyA123456789012345678901"));
      assert.ok(sanitized.includes("[REDACTED]"));
    });

    it("should detect sensitive paths while permitting .env.example", () => {
      assert.strictEqual(isSensitiveFilePath(".env"), true);
      assert.strictEqual(isSensitiveFilePath(".env.local"), true);
      assert.strictEqual(isSensitiveFilePath(".git/config"), true);
      assert.strictEqual(isSensitiveFilePath(".ssh/id_rsa"), true);
      assert.strictEqual(isSensitiveFilePath(".npmrc"), true);
      assert.strictEqual(isSensitiveFilePath("keys/server.pem"), true);
      assert.strictEqual(isSensitiveFilePath(".env.example"), false);
      assert.strictEqual(isSensitiveFilePath("src/flask/cli.py"), false);
    });

    it("should strip secret environment variables from child processes", () => {
      const clean = sanitizeProcessEnv({
        PATH: "/usr/bin",
        OPENAI_API_KEY: "sk-1234567890",
        TRUEFORGE_API_KEY: "tf-secret",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
        NODE_TEST_CONTEXT: "child-v8",
        FLASK_DEBUG: "off",
      });
      assert.strictEqual(clean.PATH, "/usr/bin");
      assert.strictEqual(clean.FLASK_DEBUG, "off");
      assert.strictEqual(clean.OPENAI_API_KEY, undefined);
      assert.strictEqual(clean.TRUEFORGE_API_KEY, undefined);
      assert.strictEqual(clean.AWS_SECRET_ACCESS_KEY, undefined);
      assert.strictEqual(clean.NODE_TEST_CONTEXT, undefined);
    });
  });

  describe("PathGuard", () => {
    it("should block traversal, absolute paths, drive letters, UNC paths, and null bytes", () => {
      const attacks = [
        "../outside.txt",
        "src/../../etc/passwd",
        "C:\\Windows\\System32\\drivers\\etc\\hosts",
        "D:relative_drive.ts",
        "\\\\server\\share\\file.ts",
        "//server/share/file.ts",
        "src/app.py\0.txt",
      ];

      for (const attack of attacks) {
        assert.throws(
          () => resolveSafeWorkspacePath(tmpRoot, attack),
          SecurityError,
          `Expected SecurityError for "${attack}"`
        );
      }
    });

    it("should block unlisted dotfiles and protected directories without blanket dotfile bypass", () => {
      assert.throws(() => resolveSafeWorkspacePath(tmpRoot, ".env"), SecurityError);
      assert.throws(() => resolveSafeWorkspacePath(tmpRoot, ".npmrc"), SecurityError);
      assert.throws(() => resolveSafeWorkspacePath(tmpRoot, ".bashrc"), SecurityError);
      assert.throws(() => resolveSafeWorkspacePath(tmpRoot, ".git/HEAD"), SecurityError);
      assert.throws(() => resolveSafeWorkspacePath(tmpRoot, "node_modules/pkg/index.js"), SecurityError);

      // Explicit allowed dotfiles still work
      const gitignore = resolveSafeWorkspacePath(tmpRoot, ".gitignore", { mustExist: true });
      assert.ok(gitignore.endsWith(".gitignore"));
    });

    it("should block disallowed executables and binary files", async () => {
      assert.throws(() => resolveSafeWorkspacePath(tmpRoot, "evil.exe"), SecurityError);
      assert.throws(() => resolveSafeWorkspacePath(tmpRoot, "run.ps1"), SecurityError);
      assert.throws(() => resolveSafeWorkspacePath(tmpRoot, "script.sh"), SecurityError);
      assert.strictEqual(isBinaryBuffer(Buffer.from([0x00, 0x01, 0x02])), true);
      assert.strictEqual(isBinaryBuffer(Buffer.from("plain utf8 text\n")), false);

      await assert.rejects(
        () => safeReadWorkspaceTextFile(tmpRoot, "src/bin.txt"),
        SecurityError
      );
    });

    it("should safely read valid workspace source files and compute SHA-256", async () => {
      const res = await safeReadWorkspaceTextFile(tmpRoot, "src/app.py");
      assert.strictEqual(res.relativePath, "src/app.py");
      assert.ok(res.content.includes("def hello()"));
      assert.strictEqual(res.sha256.length, 64);
    });
  });

  describe("CommandPolicy", () => {
    it("should reject arbitrary executables, shell injection, and unsafe flags", () => {
      assert.throws(() => validateCommandSpec("bash", ["-c", "whoami"], tmpRoot), SecurityError);
      assert.throws(() => validateCommandSpec("powershell", ["-Command", "ls"], tmpRoot), SecurityError);
      assert.throws(() => validateCommandSpec("node", ["-e", "process.exit(0)"], tmpRoot), SecurityError);
      // Prompt 005 gap fix: non-test source files cannot be passed to node --test
      assert.throws(() => validateCommandSpec("node", ["--test", "src/app.py"], tmpRoot), SecurityError);
      assert.throws(() => validateCommandSpec("python", ["-c", "import os; os.system('id')"], tmpRoot), SecurityError);
      assert.throws(() => validateCommandSpec("git", ["commit", "-m", "bad"], tmpRoot), SecurityError);
      assert.throws(() => validateCommandSpec("git", ["push"], tmpRoot), SecurityError);
      assert.throws(() => validateCommandSpec("pytest", ["tests/test_cli.py; whoami"], tmpRoot), SecurityError);
      assert.throws(() => validateCommandSpec("npm", ["install", "evil-pkg"], tmpRoot), SecurityError);
    });

    it("should allow safe pytest, flask, node --test, and read-only git commands", () => {
      const p1 = validateCommandSpec("pytest", ["tests/test_cli.py", "-q"], tmpRoot);
      assert.strictEqual(p1.executable, "pytest");

      const p2 = validateCommandSpec("flask", ["--help"], tmpRoot);
      assert.strictEqual(p2.executable, "flask");

      const p3 = validateCommandSpec("flask", ["--app", "app:create_app", "config"], tmpRoot);
      assert.strictEqual(p3.executable, "flask");

      const p4 = validateCommandSpec("node", ["--test", "tests/sample.test.mjs"], tmpRoot, {
        requireTestTargetExist: true,
      });
      assert.strictEqual(p4.executable, "node");

      const p5 = validateCommandSpec("git", ["status", "--porcelain"], tmpRoot);
      assert.strictEqual(p5.executable, "git");
    });

    it("should execute valid tests, enforce timeout, and terminate on AbortSignal", async () => {
      const passSpec = validateCommandSpec("node", ["--test", "tests/sample.test.mjs"], tmpRoot, {
        requireTestTargetExist: true,
      });
      const passRes = await executeSafeWorkspaceCommand(passSpec, { cwd: tmpRoot, timeoutMs: 5000 });
      assert.strictEqual(passRes.passed, true);
      assert.strictEqual(passRes.exitCode, 0);

      // Timeout enforcement
      const slowSpec = validateCommandSpec("node", ["--test", "tests/slow.test.mjs"], tmpRoot, {
        requireTestTargetExist: true,
      });
      const timeoutRes = await executeSafeWorkspaceCommand(slowSpec, { cwd: tmpRoot, timeoutMs: 600 });
      assert.strictEqual(timeoutRes.passed, false);
      assert.strictEqual(timeoutRes.timedOut, true);

      // AbortSignal cancellation
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 300);
      const cancelRes = await executeSafeWorkspaceCommand(slowSpec, {
        cwd: tmpRoot,
        timeoutMs: 8000,
        signal: controller.signal,
      });
      assert.strictEqual(cancelRes.passed, false);
      assert.strictEqual(cancelRes.cancelled, true);
    });
  });
});
