import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseMentions } from "../../context/mentionParser";
import { resolveWorkspaceSymbol } from "../../context/symbolResolver";
import { searchAndRankWorkspace, tokenizeQuery } from "../../context/relevanceRanker";
import { assembleWorkspaceContext } from "../../context/contextAssembler";
import {
  ContextBudgetTracker,
  estimateTokens,
  CONTEXT_TOKEN_ESTIMATION_METHOD,
} from "../../context/tokenBudget";

describe("Unit: Context Assembly (@file, @symbol, BM25 Ranking, Token Budget)", () => {
  let tmpRepo: string;

  before(() => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "patchpilot-ctx-test-"));
    fs.mkdirSync(path.join(tmpRepo, "src", "flask"), { recursive: true });
    fs.mkdirSync(path.join(tmpRepo, "tests"), { recursive: true });
    fs.mkdirSync(path.join(tmpRepo, "docs"), { recursive: true });

    fs.writeFileSync(
      path.join(tmpRepo, "src", "flask", "helpers.py"),
      `import os\n\ndef get_debug_flag() -> bool:\n    """Get whether debug mode should be enabled."""\n    val = os.environ.get("FLASK_DEBUG")\n    return bool(val and val.lower() not in {"0", "false", "no"})\n`,
      "utf8"
    );

    fs.writeFileSync(
      path.join(tmpRepo, "src", "flask", "cli.py"),
      `import click\n\n@click.command("routes")\ndef routes_command():\n    """Show the routes for the app."""\n    pass\n\ndef main():\n    """CLI entry point for flask commands."""\n    pass\n`,
      "utf8"
    );

    fs.writeFileSync(
      path.join(tmpRepo, "tests", "test_cli.py"),
      `def test_routes_command(runner):\n    result = runner.invoke(args=["routes"])\n    assert result.exit_code == 0\n`,
      "utf8"
    );

    fs.writeFileSync(
      path.join(tmpRepo, "docs", "cli.rst"),
      "Command Line Interface\n======================\n\nBuilt-in commands include ``flask run`` and ``flask routes``.\n",
      "utf8"
    );

    fs.writeFileSync(
      path.join(tmpRepo, "src", "flask", "unrelated_large.py"),
      `# unrelated filler\n${"x = 1234567890\n".repeat(400)}`,
      "utf8"
    );

    fs.writeFileSync(path.join(tmpRepo, ".env"), "SECRET_KEY=should-never-appear\n", "utf8");
  });

  after(() => {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  it("should parse explicit @file, @symbol, and shorthand file mentions without false positives", () => {
    const parsed = parseMentions(
      "Update @file:src/flask/helpers.py and @symbol:get_debug_flag plus @tests/test_cli.py (contact dev@example.com)"
    );
    assert.deepStrictEqual(parsed.fileMentions, ["src/flask/helpers.py", "tests/test_cli.py"]);
    assert.deepStrictEqual(parsed.symbolMentions, ["get_debug_flag"]);
  });

  it("should resolve Python and documentation symbols deterministically", async () => {
    const matches = await resolveWorkspaceSymbol(tmpRepo, "get_debug_flag");
    assert.strictEqual(matches.length, 1);
    assert.strictEqual(matches[0].relativePath, "src/flask/helpers.py");
    assert.strictEqual(matches[0].kind, "function");
    assert.ok(matches[0].snippet.includes("def get_debug_flag"));
  });

  it("should rank CLI source, tests, and docs automatically without naming files (Task B pattern)", () => {
    const tokens = tokenizeQuery("Add a new built-in CLI command flask config covered by a test and documented");
    assert.ok(tokens.includes("cli"));
    assert.ok(tokens.includes("command"));

    const results = searchAndRankWorkspace(
      tmpRepo,
      "Add a new built-in CLI command flask config covered by a test and documented alongside other built-in commands"
    );
    const paths = results.map((r) => r.relativePath);
    assert.ok(paths.includes("src/flask/cli.py"), "Must discover src/flask/cli.py");
    assert.ok(paths.includes("tests/test_cli.py"), "Must discover tests/test_cli.py");
    assert.ok(paths.includes("docs/cli.rst"), "Must discover docs/cli.rst");
    assert.ok(!paths.includes(".env"), "Must never leak .env into search results");
  });

  it("should report unknown @file and @symbol references and enforce token budget", async () => {
    const plan = await assembleWorkspaceContext(
      tmpRepo,
      "Inspect @file:src/flask/helpers.py @file:src/missing.py @symbol:nonexistent_fn and CLI commands",
      { tokenBudget: 600 }
    );

    assert.strictEqual(plan.budget.budgetTokens, 600);
    assert.ok(plan.budget.usedTokens <= 600, `Expected usedTokens <= 600, got ${plan.budget.usedTokens}`);
    assert.strictEqual(plan.budget.estimationMethod, CONTEXT_TOKEN_ESTIMATION_METHOD);
    assert.ok(plan.selectedFiles.some((f) => f.relativePath === "src/flask/helpers.py" && f.source === "explicit_file"));
    assert.ok(plan.unknownReferences.some((u) => u.kind === "file" && u.reference === "src/missing.py"));
    assert.ok(plan.unknownReferences.some((u) => u.kind === "symbol" && u.reference === "nonexistent_fn"));

    const tracker = new ContextBudgetTracker(100);
    assert.strictEqual(tracker.allocate("explicitFiles", estimateTokens("a".repeat(200))), true);
    assert.strictEqual(tracker.allocate("retrievedSnippets", 80), false);
  });
});
