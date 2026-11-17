import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEST_FILES = [
  "security.test.js",
  "mcp-protocol.test.js",
  "isolation.test.js",
  "adapter.test.js",
  "cancellation.test.js",
  "trueforge-integration.test.js",
];

console.log("==================================================================");
console.log("       PATCHPILOT PROMPT 005: COMPREHENSIVE SPIKE VERIFICATION     ");
console.log("==================================================================\n");

let passedSuites = 0;
let failedSuites = 0;

for (const testFile of TEST_FILES) {
  const fullPath = path.join(__dirname, testFile);
  console.log(`\n>>> Running: ${testFile} <<<`);
  try {
    const stdout = execFileSync("node", ["--test", fullPath], {
      encoding: "utf8",
      stdio: ["inherit", "pipe", "pipe"],
    });
    console.log(stdout);
    passedSuites++;
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string };
    if (execErr.stdout) console.log(execErr.stdout);
    if (execErr.stderr) console.error(execErr.stderr);
    console.error(`[FAIL] Test suite ${testFile} encountered failures`);
    failedSuites++;
  }
}

console.log("\n==================================================================");
console.log(`SUMMARY: ${passedSuites} suites passed, ${failedSuites} suites failed.`);
console.log("==================================================================");

if (failedSuites > 0) {
  process.exit(1);
} else {
  console.log("\nALL PROMPT 005 MCP WORKSPACE ACCESS SUITES PASSED CLEANLY!");
}
