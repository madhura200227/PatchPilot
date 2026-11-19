import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { PatchPilotExtensionApi } from "../../../extension";

describe("VS Code Extension Development Host E2E Verification", function () {
  this.timeout(30000);

  let api: PatchPilotExtensionApi;
  let workspaceRoot: string;

  before(async () => {
    const ext = vscode.extensions.getExtension<PatchPilotExtensionApi>("madhura200227.patchpilot");
    assert.ok(ext, "PatchPilot extension must be discovered by real VS Code Extension Host");
    api = await ext.activate();
    assert.ok(api && api.controller, "PatchPilot extension activate() must return API");

    const folders = vscode.workspace.workspaceFolders;
    assert.ok(folders && folders.length > 0, "Disposable test workspace folder must be open");
    workspaceRoot = folders[0].uri.fsPath;
  });

  after(async () => {
    if (api?.controller) {
      await api.controller.dispose();
    }
  });

  it("1. Registers all required MVP commands in the real VS Code command registry", async () => {
    const allCommands = await vscode.commands.getCommands(true);
    const required = [
      "patchpilot.openAgent",
      "patchpilot.inlineEdit",
      "patchpilot.startAgentRun",
      "patchpilot.cancelRun",
      "patchpilot.reviewChanges",
      "patchpilot.applyAcceptedChanges",
      "patchpilot.discardChanges",
      "patchpilot.undoLastApply",
      "patchpilot.checkTrueForge",
      "patchpilot.configureTrueForge",
      "patchpilot.showSession",
    ];
    for (const cmd of required) {
      assert.ok(allCommands.includes(cmd), `Missing command in Extension Host: ${cmd}`);
    }
  });

  it("2. Starts out-of-process MCP workspace server inside Electron Extension Host and passes health check", async () => {
    const mcpAdapter = api.controller.getMcpAdapter();
    const status = await mcpAdapter.ensureStarted(workspaceRoot);
    assert.strictEqual(status.state, "running");
    assert.strictEqual(status.host, "127.0.0.1");
    assert.ok(status.port && status.port > 0);
    assert.ok(status.pid && status.pid > 0);

    const health = await mcpAdapter.checkHealth();
    assert.strictEqual(health.healthy, true);
  });

  it("3. Opens Agent sidebar view and Change Review panel cleanly", async () => {
    await vscode.commands.executeCommand("patchpilot.openAgent");
    await vscode.commands.executeCommand("patchpilot.reviewChanges");
    assert.strictEqual(api.reviewPanelProvider.isOpen(), true, "Review panel must open");
  });

  it("4. Supports hunk-by-hunk selective accept/reject, WorkspaceEdit apply, and safe Undo in real VS Code", async () => {
    const targetPath = path.join(workspaceRoot, "src", "helpers.py");
    const originalContent = fs.readFileSync(targetPath, "utf8");

    const store = api.controller.getMcpAdapter().getProposalStore();
    assert.ok(store, "ProposalStore must be initialized");

    // Propose changes in two distant hunks
    const proposedContent = originalContent
      .replace(
        'return bool(val and val.lower() not in {"0", "false", "no"})',
        'return bool(val and val.lower() not in {"0", "false", "no", "off", "n"})'
      )
      .replace("return 1", "return 42");

    const created = await store.createOrUpdateProposal({
      relativePath: "src/helpers.py",
      proposedContent,
      summary: "Update get_debug_flag and helper_two",
    });

    assert.strictEqual(created.proposal.hunks.length, 2, "Expected 2 independent hunks");
    // Host file must remain untouched before apply!
    assert.strictEqual(fs.readFileSync(targetPath, "utf8"), originalContent);

    // Accept hunk-1 ONLY, reject hunk-2
    api.controller.setHunkDecision(created.proposal.proposalId, created.proposal.hunks[0].id, "accepted");
    api.controller.setHunkDecision(created.proposal.proposalId, created.proposal.hunks[1].id, "rejected");

    const applyResult = await vscode.commands.executeCommand("patchpilot.applyAcceptedChanges") as {
      appliedFiles: Array<{ relativePath: string; appliedHunkIds: string[] }>;
    };
    assert.ok(applyResult && applyResult.appliedFiles.length === 1);
    assert.deepStrictEqual(applyResult.appliedFiles[0].appliedHunkIds, ["hunk-1"]);

    const afterApply = fs.readFileSync(targetPath, "utf8");
    assert.ok(afterApply.includes('"off", "n"'), "Accepted hunk 1 must be applied via WorkspaceEdit");
    assert.ok(afterApply.includes("return 1"), "Rejected hunk 2 must NOT be applied");

    // Undo via real VS Code command
    const undoResult = await vscode.commands.executeCommand("patchpilot.undoLastApply") as {
      success: boolean;
      restoredFiles: string[];
    };
    assert.strictEqual(undoResult.success, true);
    assert.deepStrictEqual(undoResult.restoredFiles, ["src/helpers.py"]);
    assert.strictEqual(fs.readFileSync(targetPath, "utf8"), originalContent);
  });

  it("5. Captures real editor selection for inline edit and fails cleanly without mutating files when TrueForge is unreachable (Task C)", async () => {
    const targetPath = path.join(workspaceRoot, "src", "helpers.py");
    const beforeContent = fs.readFileSync(targetPath, "utf8");

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(targetPath));
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(new vscode.Position(2, 0), new vscode.Position(5, 60));

    // Configured baseUrl is http://127.0.0.1:18799 (unreachable)
    const runRes = await vscode.commands.executeCommand(
      "patchpilot.inlineEdit",
      "Treat 'off' and 'n' as false as well."
    );
    assert.strictEqual(runRes, undefined, "Failed unreachable TrueForge turn must fail cleanly");

    // Workspace file must remain 100% unchanged!
    assert.strictEqual(fs.readFileSync(targetPath, "utf8"), beforeContent);

    const sessionSnap = (await vscode.commands.executeCommand("patchpilot.showSession")) as {
      workspaceName: string;
      mcpStatus: string;
    };
    assert.strictEqual(sessionSnap.workspaceName, "workspace");
    assert.strictEqual(sessionSnap.mcpStatus, "running");
  });

  it("6. Cleanly stops managed MCP child process on controller disposal", async () => {
    await api.controller.dispose();
    assert.strictEqual(api.controller.getMcpAdapter().getStatus().state, "stopped");
  });
});
