import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  generateDiffHunks,
  applySelectedHunks,
  detectSelectionExpansion,
  computeSha256,
} from "../../workspace/patchEngine";
import { ProposalStore } from "../../workspace/proposalStore";
import { applyAcceptedProposals } from "../../workspace/hunkReview";
import { UndoManager } from "../../workspace/undoManager";
import { runCommandInExecutionOverlay } from "../../workspace/executionOverlay";
import { validateCommandSpec } from "../../security/commandPolicy";

describe("Unit: PatchEngine, ProposalStore, HunkReview, UndoManager, and ExecutionOverlay", () => {
  let tmpWs: string;

  beforeEach(() => {
    tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "patchpilot-ws-test-"));
    fs.mkdirSync(path.join(tmpWs, "src"), { recursive: true });
    fs.mkdirSync(path.join(tmpWs, "tests"), { recursive: true });

    const originalLines = [
      "export function add(a: number, b: number): number {",
      "  return a - b; // bug",
      "}",
      "",
      "// line 5",
      "// line 6",
      "// line 7",
      "// line 8",
      "// line 9",
      "// line 10",
      "// line 11",
      "export function multiply(a: number, b: number): number {",
      "  return a + b; // bug",
      "}",
      "",
    ].join("\n");

    fs.writeFileSync(path.join(tmpWs, "src", "math.ts"), originalLines, "utf8");
    fs.writeFileSync(
      path.join(tmpWs, "src", "calc.mjs"),
      "export function add(a, b) { return a - b; }\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(tmpWs, "tests", "calc.test.mjs"),
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/calc.mjs';\ntest('add', () => assert.equal(add(2, 3), 5));\n",
      "utf8"
    );
  });

  afterEach(() => {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  });

  it("should decompose distant edits into separate hunks and apply ONLY accepted hunks", () => {
    const orig = fs.readFileSync(path.join(tmpWs, "src", "math.ts"), "utf8");
    const proposed = orig
      .replace("return a - b; // bug", "return a + b;")
      .replace("return a + b; // bug", "return a * b;");

    const hunks = generateDiffHunks(orig, proposed, 2);
    assert.strictEqual(hunks.length, 2, "Expected 2 separate hunks");

    // Accept hunk-1, reject hunk-2
    hunks[0].decision = "accepted";
    hunks[1].decision = "rejected";

    const patched = applySelectedHunks(orig, hunks, proposed);
    assert.ok(patched.includes("return a + b;"), "Accepted hunk 1 must be applied");
    assert.ok(patched.includes("return a + b; // bug"), "Rejected hunk 2 must remain unchanged");
  });

  it("should detect when an inline edit expands beyond the selected line range", () => {
    const orig = "line1\nline2\nline3\nline4\nline5\n";
    const inside = "line1\nLINE2_MOD\nline3\nline4\nline5\n";
    const outside = "LINE1_MOD\nLINE2_MOD\nline3\nline4\nline5\n";

    const r1 = detectSelectionExpansion(orig, inside, 2, 3);
    assert.strictEqual(r1.expanded, false);

    const r2 = detectSelectionExpansion(orig, outside, 2, 3);
    assert.strictEqual(r2.expanded, true);
    assert.ok(r2.reason?.includes("outside the selected range"));
  });

  it("should create proposals without mutating workspace, detect staleness, apply multi-file, and undo safely", async () => {
    const store = new ProposalStore(tmpWs);
    const undo = new UndoManager();

    try {
      const origMath = fs.readFileSync(path.join(tmpWs, "src", "math.ts"), "utf8");
      const origMathSha = computeSha256(origMath);

      const proposedMath = origMath.replace("return a - b; // bug", "return a + b;");
      const p1 = await store.createOrUpdateProposal({
        relativePath: "src/math.ts",
        proposedContent: proposedMath,
        summary: "Fix add()",
      });
      const p2 = await store.createOrUpdateProposal({
        relativePath: "src/new_helper.ts",
        proposedContent: "export const VERSION = '1.0.0';\n",
        summary: "Create new helper",
      });

      // Verify actual workspace is STILL untouched
      assert.strictEqual(
        computeSha256(fs.readFileSync(path.join(tmpWs, "src", "math.ts"), "utf8")),
        origMathSha
      );
      assert.strictEqual(fs.existsSync(path.join(tmpWs, "src", "new_helper.ts")), false);

      // Accept hunks on both proposals and apply
      store.setAllHunksDecision(p1.proposal.proposalId, "accepted");
      store.setAllHunksDecision(p2.proposal.proposalId, "accepted");

      const applyRes = await applyAcceptedProposals(tmpWs, store, undo);
      assert.strictEqual(applyRes.appliedFiles.length, 2);
      assert.strictEqual(applyRes.staleConflicts.length, 0);
      assert.ok(applyRes.undoBatchId);
      assert.ok(fs.readFileSync(path.join(tmpWs, "src", "math.ts"), "utf8").includes("return a + b;"));
      assert.strictEqual(fs.existsSync(path.join(tmpWs, "src", "new_helper.ts")), true);

      // Undo should restore math.ts and delete new_helper.ts
      const undoRes = await undo.undoLastApply();
      assert.strictEqual(undoRes.success, true);
      assert.deepStrictEqual(undoRes.restoredFiles, ["src/math.ts"]);
      assert.deepStrictEqual(undoRes.deletedNewFiles, ["src/new_helper.ts"]);
      assert.strictEqual(fs.readFileSync(path.join(tmpWs, "src", "math.ts"), "utf8"), origMath);
      assert.strictEqual(fs.existsSync(path.join(tmpWs, "src", "new_helper.ts")), false);
    } finally {
      store.cleanup();
    }
  });

  it("should detect stale proposal on apply and refuse undo if user edited file after apply", async () => {
    const store = new ProposalStore(tmpWs);
    const undo = new UndoManager();

    try {
      const origCalc = fs.readFileSync(path.join(tmpWs, "src", "calc.mjs"), "utf8");
      const created = await store.createOrUpdateProposal({
        relativePath: "src/calc.mjs",
        proposedContent: "export function add(a, b) { return a + b; }\n",
      });
      store.setAllHunksDecision(created.proposal.proposalId, "accepted");

      // Simulate user editing the file before apply
      fs.writeFileSync(path.join(tmpWs, "src", "calc.mjs"), "// user edit\n" + origCalc, "utf8");

      const staleRes = await applyAcceptedProposals(tmpWs, store, undo);
      assert.strictEqual(staleRes.appliedFiles.length, 0);
      assert.strictEqual(staleRes.staleConflicts.length, 1);
      assert.strictEqual(store.getProposal(created.proposal.proposalId)?.status, "stale");

      // Reset file and test post-apply user edit blocking undo
      fs.writeFileSync(path.join(tmpWs, "src", "calc.mjs"), origCalc, "utf8");
      const fresh = await store.createOrUpdateProposal({
        relativePath: "src/calc.mjs",
        proposedContent: "export function add(a, b) { return a + b; }\n",
      });
      store.setAllHunksDecision(fresh.proposal.proposalId, "accepted");
      const applied = await applyAcceptedProposals(tmpWs, store, undo);
      assert.strictEqual(applied.appliedFiles.length, 1);

      // User modifies file after PatchPilot applied
      fs.writeFileSync(
        path.join(tmpWs, "src", "calc.mjs"),
        "export function add(a, b) { return a + b + 1; }\n",
        "utf8"
      );

      const undoBlocked = await undo.undoLastApply();
      assert.strictEqual(undoBlocked.success, false);
      assert.strictEqual(undoBlocked.conflicts.length, 1);
      // Confirm user's newer edit was NOT overwritten
      assert.ok(fs.readFileSync(path.join(tmpWs, "src", "calc.mjs"), "utf8").includes("+ 1"));
    } finally {
      store.cleanup();
    }
  });

  it("should execute tests against proposed changes in disposable overlay without mutating host workspace", async () => {
    const store = new ProposalStore(tmpWs);
    try {
      const spec = validateCommandSpec("node", ["--test", "tests/calc.test.mjs"], tmpWs, {
        requireTestTargetExist: true,
      });

      // Before proposal: test fails in overlay
      const beforeRes = await runCommandInExecutionOverlay(tmpWs, store.listProposals(), spec);
      assert.strictEqual(beforeRes.passed, false);
      assert.strictEqual(beforeRes.overlayCleanedUp, true);

      // Create proposal fixing add()
      await store.createOrUpdateProposal({
        relativePath: "src/calc.mjs",
        proposedContent: "export function add(a, b) { return a + b; }\n",
      });

      // After proposal: test PASSES in overlay while real workspace still has the bug!
      const afterRes = await runCommandInExecutionOverlay(tmpWs, store.listProposals(), spec);
      assert.strictEqual(afterRes.passed, true);
      assert.deepStrictEqual(afterRes.materializedProposals, ["src/calc.mjs"]);
      assert.strictEqual(afterRes.overlayCleanedUp, true);
      assert.ok(
        fs.readFileSync(path.join(tmpWs, "src", "calc.mjs"), "utf8").includes("a - b"),
        "Real workspace file must remain unmodified until human review & apply!"
      );
    } finally {
      store.cleanup();
    }
  });

  it("should block new proposals and discard pending proposals when a run is cancelled", async () => {
    const store = new ProposalStore(tmpWs);
    try {
      store.setActiveRun("run-cancel-1");
      await store.createOrUpdateProposal({
        relativePath: "src/calc.mjs",
        proposedContent: "export function add(a, b) { return a + b; }\n",
        runId: "run-cancel-1",
      });
      assert.strictEqual(store.listProposals().length, 1);

      const discarded = store.markRunCancelled("run-cancel-1");
      assert.strictEqual(discarded, 1);
      assert.strictEqual(store.listProposals().length, 0);

      await assert.rejects(() =>
        store.createOrUpdateProposal({
          relativePath: "src/calc.mjs",
          proposedContent: "export function add(a, b) { return a + b; }\n",
          runId: "run-cancel-1",
        })
      );
    } finally {
      store.cleanup();
    }
  });
});
