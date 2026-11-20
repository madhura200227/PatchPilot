import assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { TrueForgeResolvedConfig } from "../../config/configuration";
import { ExtensionState } from "../../state/extensionState";
import {
  DEFAULT_PATCHPILOT_AGENT_NAME,
  TrueForgeAgentManager,
} from "../../trueforge/agentManager";
import { ApprovalManager } from "../../trueforge/approvalManager";
import { TrueForgeClientFactory } from "../../trueforge/clientFactory";
import { SessionManager } from "../../trueforge/sessionManager";
import { TurnStreamManager } from "../../trueforge/turnStream";
import { applyAcceptedProposals } from "../../workspace/hunkReview";
import { computeSha256, formatUnifiedDiff } from "../../workspace/patchEngine";
import { captureSelectionContext } from "../../workspace/rangeEdit";
import { UndoManager } from "../../workspace/undoManager";
import {
  DEFAULT_MCP_CONNECTOR_NAME,
  WorkspaceMcpAdapter,
} from "../../workspace/WorkspaceMcpAdapter";
import { MockLogger } from "../testHelpers";

const FLASK_BENCHMARK_DIR =
  process.env.PATCHPILOT_FLASK_BENCHMARK_DIR ||
  path.join(os.tmpdir(), "patchpilot-flask-benchmark");

const OFFICIAL_TASK_A_INSTRUCTION =
  "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";

async function probeTrueForge(urlStr: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const url = new URL(urlStr);
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port || 8790,
          path: "/api/v1/models",
          method: "GET",
          timeout: 2500,
        },
        (res) => resolve(res.statusCode === 200)
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    } catch {
      resolve(false);
    }
  });
}

describe("Live Acceptance: Official Forge-a-thon Task A (Real TrueForge Model + Flask 3.1.3 Inline Range Edit)", function () {
  this.timeout(300000);

  const clientFactory = new TrueForgeClientFactory();
  let trueForgeBaseUrl: string | null = null;
  let mcpAdapter: WorkspaceMcpAdapter | null = null;
  let createdSessionId: string | undefined;
  let tempAgentId: string | undefined;

  before(async () => {
    for (const candidate of ["http://127.0.0.1:8790", "http://localhost:8790"]) {
      if (await probeTrueForge(candidate)) {
        trueForgeBaseUrl = candidate;
        break;
      }
    }
  });

  after(async () => {
    if (trueForgeBaseUrl) {
      const client = clientFactory.createClient({
        baseUrl: trueForgeBaseUrl,
        agentName: DEFAULT_PATCHPILOT_AGENT_NAME,
        requestTimeoutSeconds: 30,
      });
      if (createdSessionId) {
        await client.sessions.delete(createdSessionId).catch(() => {});
      }
      if (tempAgentId) {
        await client.agents.delete(tempAgentId).catch(() => {});
      }
    }
    if (mcpAdapter) {
      await mcpAdapter.dispose();
    }
  });

  it("executes real model-backed Task A via TrueForge range-edit pipeline, preserves all 641 lines outside selection, verifies FLASK_DEBUG=off -> False, and cleanly restores benchmark via Undo", async function () {
    if (!trueForgeBaseUrl || !fs.existsSync(path.join(FLASK_BENCHMARK_DIR, "src", "flask", "helpers.py"))) {
      console.warn(
        `[SKIP] Live TrueForge (${trueForgeBaseUrl || "unavailable"}) or Flask benchmark (${FLASK_BENCHMARK_DIR}) not present.`
      );
      this.skip();
      return;
    }

    const logger = new MockLogger();
    const state = new ExtensionState();
    const baseCfg: TrueForgeResolvedConfig = {
      baseUrl: trueForgeBaseUrl,
      agentName: DEFAULT_PATCHPILOT_AGENT_NAME,
      mcpConnectorName: DEFAULT_MCP_CONNECTOR_NAME,
      requestTimeoutSeconds: 60,
    };

    const client = clientFactory.createClient(baseCfg);
    const modelsResp = await client.models.list();
    if (!modelsResp.data || modelsResp.data.length === 0) {
      console.warn("[BLOCKED] No configured models on TrueForge server.");
      this.skip();
      return;
    }

    // Use the model already configured on the 'patchpilot' agent, an explicit PATCHPILOT_LIVE_MODEL
    // selected from TrueForge's live models.list(), or the first configured TrueForge model (never hardcoded!)
    const agentsResp = await client.agents.list({ limit: 50 });
    const existingAgent = (agentsResp.data ?? []).find((a) => a.name === DEFAULT_PATCHPILOT_AGENT_NAME);
    const requestedModel = process.env.PATCHPILOT_LIVE_MODEL?.trim();
    const matchedRequested = requestedModel
      ? modelsResp.data.find((m) => m.name === requestedModel)
      : undefined;
    const activeModelName =
      matchedRequested?.name || existingAgent?.manifest?.model?.name || modelsResp.data[0].name;
    const runAgentName = matchedRequested ? "patchpilot-task-a-live-verify" : DEFAULT_PATCHPILOT_AGENT_NAME;
    const runCfg: TrueForgeResolvedConfig = {
      ...baseCfg,
      agentName: runAgentName,
    };

    // 1. Verify Flask benchmark git state is clean before testing
    const gitBefore = execFileSync("git", ["-C", FLASK_BENCHMARK_DIR, "status", "--short"], {
      encoding: "utf8",
    }).trim();
    assert.strictEqual(
      gitBefore,
      "",
      `Flask benchmark must start clean before Task A test, got:\n${gitBefore}`
    );

    const helpersAbsPath = path.join(FLASK_BENCHMARK_DIR, "src", "flask", "helpers.py");
    const originalContent = fs.readFileSync(helpersAbsPath, "utf8");
    const originalSha = computeSha256(originalContent);
    const rawLines = originalContent.replace(/\r\n/g, "\n").split("\n");
    assert.ok(rawLines.length >= 641, `Expected Flask helpers.py >= 641 lines, got ${rawLines.length}`);

    // Locate get_debug_flag() exact 0-based range (lines 28-33 -> 0-based lines 27-32)
    const startLineIdx = rawLines.findIndex((l) => l.startsWith("def get_debug_flag()"));
    assert.ok(startLineIdx >= 0, "Could not locate def get_debug_flag() in Flask helpers.py");
    let endLineIdx = startLineIdx;
    while (endLineIdx + 1 < rawLines.length && rawLines[endLineIdx + 1].trim() !== "") {
      endLineIdx++;
    }

    const inlineEditContext = captureSelectionContext(
      "src/flask/helpers.py",
      originalContent,
      {
        start: { line: startLineIdx, character: 0 },
        end: { line: endLineIdx, character: rawLines[endLineIdx].length },
      },
      1
    );

    console.log(
      `[TASK A LIVE] Captured selection lines ${inlineEditContext.displayStartLine}-${inlineEditContext.displayEndLine} (offsets ${inlineEditContext.startOffset}..${inlineEditContext.endOffset}, eol=${JSON.stringify(inlineEditContext.eol)}, model=${activeModelName})`
    );

    // 2. Start production out-of-process MCP server, register connector, update live 'patchpilot' agent
    mcpAdapter = new WorkspaceMcpAdapter(clientFactory, logger, process.cwd());
    const procStatus = await mcpAdapter.ensureStarted(FLASK_BENCHMARK_DIR);
    assert.strictEqual(procStatus.state, "running");

    const reg = await mcpAdapter.registerWithTrueForge(baseCfg, DEFAULT_MCP_CONNECTOR_NAME);
    assert.strictEqual(reg.registered, true, `MCP registration failed: ${reg.error}`);

    const agentMgr = new TrueForgeAgentManager(clientFactory, logger, process.cwd());
    const ensured = await agentMgr.ensurePatchPilotAgent(runCfg, {
      modelName: activeModelName,
      agentName: runAgentName,
      mcpConnectorName: DEFAULT_MCP_CONNECTOR_NAME,
    });
    if (runAgentName !== DEFAULT_PATCHPILOT_AGENT_NAME) {
      tempAgentId = ensured.agentId;
    }
    console.log(`[TASK A LIVE] Synced TrueForge agent "${ensured.agentName}" (${ensured.agentId}) with updated range-edit instructions.`);

    const runId = `task-a-live-${Date.now()}`;
    await mcpAdapter.setActiveRun(runId, undefined, inlineEditContext);

    // 3. Create real TrueForge session & dispatch exact Inline Range-Edit prompt
    const sessionMgr = new SessionManager(clientFactory, state, logger);
    createdSessionId = await sessionMgr.createSession(runCfg, { forceNew: true });

    const ctxStart = Math.max(0, startLineIdx - 15);
    const ctxEnd = Math.min(rawLines.length - 1, endLineIdx + 15);
    const surroundingContext = rawLines
      .slice(ctxStart, ctxEnd + 1)
      .map((l, idx) => `${ctxStart + idx + 1}: ${l}`)
      .join("\n");

    const prompt = [
      "Inline Range-Edit Request (MODE = range):",
      `File: ${inlineEditContext.relativePath}`,
      `Selected Lines (1-based display): ${inlineEditContext.displayStartLine}-${inlineEditContext.displayEndLine}`,
      `Selected Range (0-based UTF-16): start={line: ${inlineEditContext.range.start.line}, character: ${inlineEditContext.range.start.character}}, end={line: ${inlineEditContext.range.end.line}, character: ${inlineEditContext.range.end.character}}`,
      "",
      "EXACT Selected Text to Replace:",
      "```",
      inlineEditContext.selectedText,
      "```",
      "",
      "Read-Only Surrounding Context (for reference ONLY — do NOT include in replacement):",
      "```",
      surroundingContext,
      "```",
      "",
      `User Instruction: ${OFFICIAL_TASK_A_INSTRUCTION}`,
      "",
      "CRITICAL TOOL CONTRACT:",
      `- Call propose_edit with path="${inlineEditContext.relativePath}", mode="range", and replacement="<ONLY the updated text replacing the exact selected range above>".`,
      '- Do NOT pass mode="full_file", do NOT pass unselected imports or other functions from the file, and do NOT wrap replacement in markdown code fences.',
      "- PatchPilot mechanically preserves every character before and after the selected range and constructs the full-file diff safely.",
      "- Only if lines outside the selected range genuinely must change, also pass expandedRange (0-based {start:{line,character}, end:{line,character}}) and expansionReason explaining why.",
    ].join("\n");

    const approvalMgr = new ApprovalManager(clientFactory, logger);
    const streamMgr = new TurnStreamManager(clientFactory, state, logger);
    const approvedToolCalls: string[] = [];

    const turnRes = await streamMgr.executeTurn(baseCfg, createdSessionId, prompt, {
      approvalManager: approvalMgr,
      callbacks: {
        onToolCall: (tc) => {
          console.log(`[TASK A LIVE TOOL CALL] ${tc.name} (${tc.id})`);
        },
        onApprovalRequired: (pending) => {
          for (const p of pending) {
            console.log(`[TASK A LIVE APPROVAL] Human approving tool "${p.toolName}" (${p.toolCallId})`);
            approvedToolCalls.push(p.toolName);
            void approvalMgr.submitDecision(baseCfg, p.toolCallId, true);
          }
        },
        onToolResponse: (_id, name, content) => {
          console.log(`[TASK A LIVE TOOL RESULT] ${name}: ${content.slice(0, 260)}`);
        },
      },
    });

    console.log(
      `[TASK A LIVE TURN] SessionId=${createdSessionId} TurnId=${turnRes.turnId} Status=${turnRes.terminalStatus} ToolCalls=${turnRes.toolCalls.map((t) => t.name).join(",")} Approvals=${approvedToolCalls.join(",")}`
    );

    if (turnRes.terminalStatus === "ERROR" && turnRes.error?.includes("401")) {
      console.warn(`[BLOCKED] TrueForge provider returned 401: ${turnRes.error}`);
      this.skip();
      return;
    }

    assert.strictEqual(
      turnRes.terminalStatus,
      "COMPLETED",
      `Expected COMPLETED turn, got ${turnRes.terminalStatus} (${turnRes.error || ""})`
    );
    assert.ok(approvedToolCalls.includes("propose_edit"), "TrueForge approval gate for propose_edit must have fired");

    // 4. Verify disk file is STILL untouched before review/apply (Invariant 5)
    assert.strictEqual(
      computeSha256(fs.readFileSync(helpersAbsPath, "utf8")),
      originalSha,
      "Benchmark file must remain untouched prior to human hunk acceptance & apply!"
    );

    // 5. Inspect generated Proposal & verify preservation invariants
    const store = mcpAdapter.getProposalStore()!;
    const proposals = store.listProposals();
    assert.strictEqual(proposals.length, 1, `Expected 1 proposal for src/flask/helpers.py, got ${proposals.length}`);
    const proposal = proposals[0];

    const unifiedDiff = formatUnifiedDiff(proposal.relativePath, proposal.hunks);
    console.log("\n=== ACTUAL LIVE TASK A UNIFIED DIFF ===\n" + unifiedDiff + "\n=======================================\n");

    assert.strictEqual(proposal.relativePath, "src/flask/helpers.py");
    assert.strictEqual(proposal.editMode, "range");
    assert.strictEqual(proposal.prefixPreserved, true);
    assert.strictEqual(proposal.suffixPreserved, true);
    assert.strictEqual(proposal.hunks.length, 1, "Expected 1 small localized hunk in get_debug_flag()");

    const removedCount = proposal.hunks[0].removedCount;
    const addedCount = proposal.hunks[0].addedCount;
    assert.ok(removedCount <= 8, `Expected <= 8 removed lines, got ${removedCount}`);
    assert.ok(addedCount >= 2 && addedCount <= 25, `Expected localized additions, got ${addedCount}`);

    // Byte-for-byte prefix & suffix preservation on the real 641-line Flask module!
    const origPrefix = originalContent.slice(0, inlineEditContext.startOffset);
    const origSuffix = originalContent.slice(inlineEditContext.endOffset);
    assert.strictEqual(proposal.proposedContent.slice(0, origPrefix.length), origPrefix);
    assert.strictEqual(
      proposal.proposedContent.slice(proposal.proposedContent.length - origSuffix.length),
      origSuffix
    );

    // 6. Accept the reviewed hunk, apply to benchmark, run official Python verification, and undo cleanly
    const undoMgr = new UndoManager();
    store.setHunkDecision(proposal.proposalId, proposal.hunks[0].id, "accepted");

    const applyRes = await applyAcceptedProposals(FLASK_BENCHMARK_DIR, store, undoMgr);
    assert.strictEqual(applyRes.appliedFiles.length, 1);

    try {
      const venvPython = path.join(FLASK_BENCHMARK_DIR, ".venv", "Scripts", "python.exe");
      const pyExe = fs.existsSync(venvPython) ? venvPython : "python";

      const checkDebug = (val: string | undefined): string => {
        const env = { ...process.env };
        if (val === undefined) {
          delete env.FLASK_DEBUG;
        } else {
          env.FLASK_DEBUG = val;
        }
        return execFileSync(
          pyExe,
          ["-c", "from flask.helpers import get_debug_flag; print(get_debug_flag())"],
          { cwd: FLASK_BENCHMARK_DIR, env, encoding: "utf8" }
        ).trim();
      };

      const offOut = checkDebug("off");
      const offUpperOut = checkDebug("OFF");
      const nOut = checkDebug("n");
      const nUpperOut = checkDebug("N");
      const oneOut = checkDebug("1");
      const unsetOut = checkDebug(undefined);

      console.log(
        `[TASK A LIVE VERIFICATION] FLASK_DEBUG=off->${offOut}, OFF->${offUpperOut}, n->${nOut}, N->${nUpperOut}, 1->${oneOut}, unset->${unsetOut}`
      );

      assert.strictEqual(offOut, "False", "FLASK_DEBUG=off must return False");
      assert.strictEqual(offUpperOut, "False", "FLASK_DEBUG=OFF must return False");
      assert.strictEqual(nOut, "False", "FLASK_DEBUG=n must return False");
      assert.strictEqual(nUpperOut, "False", "FLASK_DEBUG=N must return False");
      assert.strictEqual(oneOut, "True", "FLASK_DEBUG=1 must still return True");
      assert.strictEqual(unsetOut, "False", "Unset FLASK_DEBUG must return False");

      const gitDiffStat = execFileSync(
        "git",
        ["-C", FLASK_BENCHMARK_DIR, "diff", "--stat", "--", "src/flask/helpers.py"],
        { encoding: "utf8" }
      ).trim();
      console.log(`[TASK A LIVE GIT DIFF STAT] ${gitDiffStat}`);
    } finally {
      // Restore benchmark cleanly via PatchPilot UndoManager so user's benchmark repo stays spotless
      const undoRes = await undoMgr.undoLastApply();
      assert.strictEqual(undoRes.success, true, `Undo failed: ${undoRes.message}`);
    }

    const gitAfter = execFileSync("git", ["-C", FLASK_BENCHMARK_DIR, "status", "--short"], {
      encoding: "utf8",
    }).trim();
    assert.strictEqual(gitAfter, "", `Expected clean Flask benchmark after Undo, got:\n${gitAfter}`);
    assert.strictEqual(computeSha256(fs.readFileSync(helpersAbsPath, "utf8")), originalSha);
    console.log("[TASK A LIVE PASS] Verified localized diff, FLASK_DEBUG=off -> False, and clean Undo restoration!");
  });
});
