import * as vscode from "vscode";
import { PatchPilotController } from "../controller/PatchPilotController";

export const PATCHPILOT_PROPOSAL_SCHEME = "patchpilot-proposal";

/**
 * Read-only VS Code TextDocumentContentProvider that powers side-by-side vscode.diff
 * inspection of original vs proposed file contents without mutating workspace files.
 */
export class ProposalDiffContentProvider implements vscode.TextDocumentContentProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  public readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(private readonly controller: PatchPilotController) {}

  public provideTextDocumentContent(uri: vscode.Uri): string {
    const params = new URLSearchParams(uri.query);
    const proposalId = params.get("proposalId") || "";
    const side = params.get("side") || "proposed";
    const proposal = this.controller.getProposalById(proposalId);
    if (!proposal) {
      return `// Proposal "${proposalId}" is no longer active.`;
    }
    return side === "original" ? proposal.originalContent : proposal.proposedContent;
  }

  public async openNativeDiff(proposalId: string): Promise<void> {
    const proposal = this.controller.getProposalById(proposalId);
    if (!proposal) {
      vscode.window.showWarningMessage("PatchPilot: Proposal not found.");
      return;
    }

    const leftUri = vscode.Uri.parse(
      `${PATCHPILOT_PROPOSAL_SCHEME}:/${encodeURIComponent(proposal.relativePath)}?proposalId=${encodeURIComponent(proposalId)}&side=original`
    );
    const rightUri = vscode.Uri.parse(
      `${PATCHPILOT_PROPOSAL_SCHEME}:/${encodeURIComponent(proposal.relativePath)}?proposalId=${encodeURIComponent(proposalId)}&side=proposed`
    );

    this.onDidChangeEmitter.fire(leftUri);
    this.onDidChangeEmitter.fire(rightUri);

    await vscode.commands.executeCommand(
      "vscode.diff",
      leftUri,
      rightUri,
      `PatchPilot Diff: ${proposal.relativePath} (Original ↔ Proposed)`
    );
  }

  public dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}
