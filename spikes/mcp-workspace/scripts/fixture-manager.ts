import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";

export const DEFAULT_FIXTURE_PATH = path.join(os.tmpdir(), "patchpilot-mcp-fixture");

export interface FixtureManifest {
  fixturePath: string;
  files: Record<string, { sha256: string; size: number }>;
  gitCommitSha: string;
  gitStatus: string;
  createdAt: string;
}

export function computeSha256(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function computeDirectoryHashes(rootDir: string): Record<string, { sha256: string; size: number }> {
  const result: Record<string, { sha256: string; size: number }> = {};

  function scan(currentDir: string) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        scan(fullPath);
      } else if (entry.isFile()) {
        const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, "/");
        const content = fs.readFileSync(fullPath);
        result[relativePath] = {
          sha256: computeSha256(content),
          size: content.length,
        };
      }
    }
  }

  if (fs.existsSync(rootDir)) {
    scan(rootDir);
  }
  return result;
}

export function createFixture(fixtureDir: string = DEFAULT_FIXTURE_PATH): FixtureManifest {
  // 1. Clean existing fixture directory if present
  if (fs.existsSync(fixtureDir)) {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(fixtureDir, "src"), { recursive: true });
  fs.mkdirSync(path.join(fixtureDir, "tests"), { recursive: true });

  // 2. Write .patchpilot-fixture marker
  fs.writeFileSync(
    path.join(fixtureDir, ".patchpilot-fixture"),
    JSON.stringify(
      {
        fixtureId: "patchpilot-mcp-fixture-v1",
        description: "Deterministic disposable test project for PatchPilot MCP workspace access proof",
        createdAt: new Date().toISOString(),
      },
      null,
      2
    ) + "\n"
  );

  // 3. Write README.md
  fs.writeFileSync(
    path.join(fixtureDir, "README.md"),
    `# PatchPilot MCP Test Fixture

This repository is a disposable, deterministic test fixture used to validate that an MCP server
and TrueForge agent can inspect, modify, and run tests in an isolated workspace.

## Purpose
- Isolated filesystem boundary outside the PatchPilot repository.
- Contains an intentional bug in \`src/calculator.ts\` where \`add(a, b)\` performs subtraction.
- Predefined test command: \`npm test\` runs \`tests/calculator.test.mjs\` (or \`node --test\`).
- Contains zero credentials, sensitive data, or personal files.
`
  );

  // 4. Write package.json
  fs.writeFileSync(
    path.join(fixtureDir, "package.json"),
    JSON.stringify(
      {
        name: "patchpilot-mcp-fixture",
        version: "1.0.0",
        description: "Deterministic disposable test project for PatchPilot MCP workspace access proof",
        type: "module",
        scripts: {
          test: "node --test tests/calculator.test.mjs",
        },
      },
      null,
      2
    ) + "\n"
  );

  // 5. Write src/calculator.ts
  fs.writeFileSync(
    path.join(fixtureDir, "src", "calculator.ts"),
    `/**
 * Deterministic Calculator for PatchPilot MCP Fixture
 */
export function add(a: number, b: number): number {
  // DELIBERATE BUG FOR AGENT REPAIR SPIKE:
  // Subtraction is performed instead of addition.
  return a - b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}
`
  );

  // 6. Write src/index.ts
  fs.writeFileSync(
    path.join(fixtureDir, "src", "index.ts"),
    `export * from "./calculator.ts";\n`
  );

  // 7. Write tests/calculator.test.ts
  fs.writeFileSync(
    path.join(fixtureDir, "tests", "calculator.test.ts"),
    `import test from "node:test";
import assert from "node:assert/strict";
import { add, subtract, multiply } from "../src/calculator.ts";

test("calculator add function returns correct sum", () => {
  const result = add(2, 3);
  assert.equal(result, 5, "Expected 2 + 3 to equal 5");
});

test("calculator subtract function returns correct difference", () => {
  const result = subtract(10, 4);
  assert.equal(result, 6, "Expected 10 - 4 to equal 6");
});

test("calculator multiply function returns correct product", () => {
  const result = multiply(3, 4);
  assert.equal(result, 12, "Expected 3 * 4 to equal 12");
});
`
  );

  // 8. Also write tests/calculator.test.mjs for deterministic pure-Node execution
  // This reads src/calculator.ts or executes deterministic assertion logic matching src/calculator.ts
  fs.writeFileSync(
    path.join(fixtureDir, "tests", "calculator.test.mjs"),
    `import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const calcPath = path.resolve(__dirname, "../src/calculator.ts");

function parseCalculatorAdd() {
  const code = fs.readFileSync(calcPath, "utf8");
  // Check if add implementation returns a + b or a - b
  const match = code.match(/export\\s+function\\s+add\\s*\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\}/);
  if (!match) throw new Error("Could not find add function in " + calcPath);
  const body = match[1];
  const fn = new Function("a", "b", body);
  return fn;
}

test("calculator add function returns correct sum", () => {
  const addFn = parseCalculatorAdd();
  const result = addFn(2, 3);
  assert.equal(result, 5, \`Expected add(2, 3) to be 5, but got \${result}\`);
});
`
  );

  // 9. Initialize git repository in fixture directory
  execFileSync("git", ["init"], { cwd: fixtureDir });
  execFileSync("git", ["config", "user.name", "PatchPilot Test Fixture"], { cwd: fixtureDir });
  execFileSync("git", ["config", "user.email", "fixture@patchpilot.local"], { cwd: fixtureDir });
  execFileSync("git", ["add", "."], { cwd: fixtureDir });
  execFileSync("git", ["commit", "-m", "chore: initial deterministic fixture state"], { cwd: fixtureDir });

  const commitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixtureDir, encoding: "utf8" }).trim();
  const gitStatus = execFileSync("git", ["status", "--porcelain"], { cwd: fixtureDir, encoding: "utf8" }).trim();
  const fileHashes = computeDirectoryHashes(fixtureDir);

  const manifest: FixtureManifest = {
    fixturePath: fixtureDir,
    files: fileHashes,
    gitCommitSha: commitSha,
    gitStatus: gitStatus || "CLEAN",
    createdAt: new Date().toISOString(),
  };

  fs.writeFileSync(
    path.join(fixtureDir, ".patchpilot-fixture-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n"
  );

  return manifest;
}

export function resetFixture(fixtureDir: string = DEFAULT_FIXTURE_PATH): void {
  if (!fs.existsSync(fixtureDir)) {
    createFixture(fixtureDir);
    return;
  }
  // Hard reset git state and remove untracked files
  execFileSync("git", ["reset", "--hard", "HEAD"], { cwd: fixtureDir });
  execFileSync("git", ["clean", "-fd"], { cwd: fixtureDir });
}

// Self-execute if invoked as CLI
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("fixture-manager.ts")) {
  const targetDir = process.argv[2] || DEFAULT_FIXTURE_PATH;
  console.log(`Generating PatchPilot test fixture at: ${targetDir}`);
  const manifest = createFixture(targetDir);
  console.log("Fixture generated successfully!");
  console.log(`Commit SHA: ${manifest.gitCommitSha}`);
  console.log("Files:", Object.keys(manifest.files));
}
