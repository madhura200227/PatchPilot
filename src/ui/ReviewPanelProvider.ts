import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { PatchPilotController } from "../controller/PatchPilotController";
import { FileProposal } from "../workspace/proposalStore";
import { ProposalDiffContentProvider } from "./ProposalDiffContentProvider";

/**
 * PatchPilot Hunk-by-Hunk Change Review Editor Panel
 *
 * Displays all proposed file changes grouped into individual diff hunks with:
 * - Accept Hunk / Reject Hunk controls per hunk
 * - File-level summary, stale warnings, and inline selection-expansion warnings
 * - Open Native VS Code Diff action
 * - Apply Accepted Changes, Discard Remaining Proposals, and Undo Last Apply
 */
export class ReviewPanelProvider {
  private panel: vscode.WebviewPanel | undefined;
  private readonly unsubProposals: () => void;

  constructor(
    private readonly controller: PatchPilotController,
    private readonly diffContentProvider: ProposalDiffContentProvider
  ) {
    this.unsubProposals = this.controller.onProposalsUpdate((proposals) => {
      this.postProposals(proposals);
    });
  }

  public open(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      this.postProposals(this.controller.getProposals());
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "patchpilot.reviewPanel",
      "PatchPilot: Review Proposed Changes",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    this.panel = panel;
    panel.webview.html = this.getHtml();

    panel.webview.onDidReceiveMessage(async (msg: Record<string, unknown>) => {
      const type = typeof msg?.type === "string" ? msg.type : "";
      switch (type) {
        case "ready": {
          this.postProposals(this.controller.getProposals());
          break;
        }
        case "setHunkDecision": {
          const proposalId = typeof msg.proposalId === "string" ? msg.proposalId : "";
          const hunkId = typeof msg.hunkId === "string" ? msg.hunkId : "";
          const decision = msg.decision === "accepted" || msg.decision === "rejected" ? msg.decision : "pending";
          if (proposalId && hunkId) {
            this.controller.setHunkDecision(proposalId, hunkId, decision);
          }
          break;
        }
        case "setAllHunks": {
          const proposalId = typeof msg.proposalId === "string" ? msg.proposalId : "";
          const decision = msg.decision === "accepted" || msg.decision === "rejected" ? msg.decision : "pending";
          if (proposalId) {
            this.controller.setAllHunksDecision(proposalId, decision);
          }
          break;
        }
        case "applyAccepted": {
          await this.controller.applyAcceptedChanges();
          break;
        }
        case "discardAll": {
          await this.controller.discardProposals();
          break;
        }
        case "undoLastApply": {
          await this.controller.undoLastApply();
          this.postProposals(this.controller.getProposals());
          break;
        }
        case "openNativeDiff": {
          const proposalId = typeof msg.proposalId === "string" ? msg.proposalId : "";
          if (proposalId) {
            await this.diffContentProvider.openNativeDiff(proposalId);
          }
          break;
        }
      }
    });

    panel.onDidDispose(() => {
      this.panel = undefined;
    });

    this.postProposals(this.controller.getProposals());
  }

  public isOpen(): boolean {
    return Boolean(this.panel);
  }

  private postProposals(proposals: FileProposal[]): void {
    if (!this.panel) {
      return;
    }
    void this.panel.webview.postMessage({
      type: "proposals",
      payload: {
        proposals,
        canUndo: this.controller.getUndoManager().hasUndoableBatch(),
      },
    });
  }

  private getHtml(): string {
    const nonce = crypto.randomBytes(16).toString("hex");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
  <title>PatchPilot Change Review</title>
  <style nonce="${nonce}">
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 16px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    .topbar {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
      margin-bottom: 14px;
    }
    .summary-stats {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    button {
      font-family: inherit;
      font-size: 12px;
      padding: 5px 11px;
      border-radius: 4px;
      border: 1px solid transparent;
      cursor: pointer;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    button.accept-active { background: #1e6f43; color: #ffffff; }
    button.reject-active { background: #9b2226; color: #ffffff; }
    button:disabled { opacity: 0.45; cursor: not-allowed; }
    .file-card {
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
      border-radius: 6px;
      margin-bottom: 16px;
      overflow: hidden;
    }
    .file-header {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      background: var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.12));
    }
    .file-path {
      font-family: var(--vscode-editor-font-family);
      font-weight: 600;
      font-size: 13px;
    }
    .badge {
      display: inline-block;
      padding: 1px 7px;
      border-radius: 10px;
      font-size: 11px;
      margin-left: 6px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .badge.accepted { background: #1e6f43; color: #fff; }
    .badge.rejected { background: #9b2226; color: #fff; }
    .badge.warn { background: #8a5a00; color: #fff; }
    .alert {
      padding: 8px 12px;
      font-size: 12px;
      background: rgba(201, 138, 0, 0.16);
      border-bottom: 1px solid rgba(201, 138, 0, 0.4);
    }
    .alert.stale {
      background: rgba(190, 17, 0, 0.16);
      border-bottom-color: rgba(190, 17, 0, 0.45);
    }
    .hunk {
      border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
    }
    .hunk-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 12px;
      background: rgba(128,128,128,0.08);
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
    }
    .diff-table {
      width: 100%;
      border-collapse: collapse;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      line-height: 1.45;
    }
    .diff-table td {
      padding: 0 8px;
      white-space: pre-wrap;
      word-break: break-word;
      vertical-align: top;
    }
    .ln {
      width: 44px;
      text-align: right;
      color: var(--vscode-editorLineNumber-foreground);
      user-select: none;
      border-right: 1px solid rgba(128,128,128,0.18);
    }
    .diff-add { background: var(--vscode-diffEditor-insertedTextBackground, rgba(46, 160, 67, 0.2)); }
    .diff-remove { background: var(--vscode-diffEditor-removedTextBackground, rgba(248, 81, 73, 0.2)); }
    .empty {
      padding: 32px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
      border: 1px dashed rgba(128,128,128,0.35);
      border-radius: 6px;
    }
  </style>
</head>
<body>
  <div class="topbar">
    <div>
      <h2 style="margin:0 0 4px 0; font-size:16px;">PatchPilot Change Review</h2>
      <div id="summaryStats" class="summary-stats">Loading proposals...</div>
    </div>
    <div class="actions">
      <button id="btnApply" disabled>Apply Accepted Changes</button>
      <button id="btnDiscard" class="secondary" disabled>Discard Remaining Proposals</button>
      <button id="btnUndo" class="secondary" disabled>Undo Last Apply</button>
    </div>
  </div>
  <div id="filesContainer"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const el = (id) => document.getElementById(id);
    const esc = (s) => String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    el('btnApply').addEventListener('click', () => vscode.postMessage({ type: 'applyAccepted' }));
    el('btnDiscard').addEventListener('click', () => vscode.postMessage({ type: 'discardAll' }));
    el('btnUndo').addEventListener('click', () => vscode.postMessage({ type: 'undoLastApply' }));

    function render(data) {
      const proposals = data.proposals || [];
      el('btnUndo').disabled = !data.canUndo;

      let totalHunks = 0, accepted = 0, rejected = 0, pending = 0;
      for (const p of proposals) {
        for (const h of p.hunks) {
          totalHunks++;
          if (h.decision === 'accepted') accepted++;
          else if (h.decision === 'rejected') rejected++;
          else pending++;
        }
      }

      el('summaryStats').textContent =
        proposals.length + ' file(s) • ' + totalHunks + ' hunk(s) (' +
        accepted + ' accepted, ' + rejected + ' rejected, ' + pending + ' pending)';
      el('btnApply').disabled = accepted === 0;
      el('btnDiscard').disabled = proposals.length === 0;

      if (proposals.length === 0) {
        el('filesContainer').innerHTML =
          '<div class="empty">No pending file proposals. Run an Agent Mode task or Inline Edit in PatchPilot to propose changes for review.</div>';
        return;
      }

      el('filesContainer').innerHTML = proposals.map((p) => {
        const staleHtml = p.status === 'stale'
          ? '<div class="alert stale"><strong>Stale Proposal:</strong> ' + esc(p.staleReason || 'Original file changed on disk since proposal creation.') + '</div>'
          : '';
        const expandHtml = (p.selectionExpansion && p.selectionExpansion.expanded)
          ? '<div class="alert"><strong>Selection Expansion Notice:</strong> ' + esc(p.selectionExpansion.reason) + '</div>'
          : '';

        const hunksHtml = p.hunks.map((h) => {
          const rows = h.lines.map((l) => {
            const cls = l.type === 'add' ? 'diff-add' : (l.type === 'remove' ? 'diff-remove' : '');
            const prefix = l.type === 'add' ? '+' : (l.type === 'remove' ? '-' : ' ');
            return '<tr class="' + cls + '">' +
              '<td class="ln">' + (l.oldLineNumber ?? '') + '</td>' +
              '<td class="ln">' + (l.newLineNumber ?? '') + '</td>' +
              '<td>' + esc(prefix + l.content) + '</td></tr>';
          }).join('');

          return \`
            <div class="hunk">
              <div class="hunk-header">
                <span>\${esc(h.id)} • \${esc(h.header)} (+\${h.addedCount} / -\${h.removedCount})
                  <span class="badge \${h.decision === 'accepted' ? 'accepted' : (h.decision === 'rejected' ? 'rejected' : '')}">\${esc(h.decision.toUpperCase())}</span>
                </span>
                <div class="actions">
                  <button class="\${h.decision === 'accepted' ? 'accept-active' : 'secondary'}" data-hunk-action="accepted" data-prop="\${esc(p.proposalId)}" data-hunk="\${esc(h.id)}">Accept Hunk</button>
                  <button class="\${h.decision === 'rejected' ? 'reject-active' : 'secondary'}" data-hunk-action="rejected" data-prop="\${esc(p.proposalId)}" data-hunk="\${esc(h.id)}">Reject Hunk</button>
                </div>
              </div>
              <table class="diff-table">\${rows}</table>
            </div>
          \`;
        }).join('');

        return \`
          <div class="file-card">
            <div class="file-header">
              <div>
                <span class="file-path">\${esc(p.relativePath)}</span>
                <span class="badge">\${p.isNewFile ? 'NEW FILE' : (p.editMode === 'range' ? 'RANGE EDIT' : 'FULL-FILE EDIT')}</span>
                \${p.editMode === 'range' && p.prefixPreserved && p.suffixPreserved ? '<span class="badge accepted">PREFIX/SUFFIX PRESERVED</span>' : ''}
                <span class="badge">\${esc(p.status)}</span>
                <div style="font-size:11px;color:var(--vscode-descriptionForeground);margin-top:3px;">\${esc(p.summary)}</div>
              </div>
              <div class="actions">
                <button class="secondary" data-native-diff="\${esc(p.proposalId)}">Open VS Code Diff</button>
                <button class="secondary" data-file-all="accepted" data-prop="\${esc(p.proposalId)}">Accept File Hunks</button>
                <button class="secondary" data-file-all="rejected" data-prop="\${esc(p.proposalId)}">Reject File Hunks</button>
              </div>
            </div>
            \${staleHtml}
            \${expandHtml}
            \${hunksHtml}
          </div>
        \`;
      }).join('');

      el('filesContainer').querySelectorAll('[data-hunk-action]').forEach((btn) => {
        btn.addEventListener('click', () => {
          vscode.postMessage({
            type: 'setHunkDecision',
            proposalId: btn.getAttribute('data-prop'),
            hunkId: btn.getAttribute('data-hunk'),
            decision: btn.getAttribute('data-hunk-action'),
          });
        });
      });

      el('filesContainer').querySelectorAll('[data-file-all]').forEach((btn) => {
        btn.addEventListener('click', () => {
          vscode.postMessage({
            type: 'setAllHunks',
            proposalId: btn.getAttribute('data-prop'),
            decision: btn.getAttribute('data-file-all'),
          });
        });
      });

      el('filesContainer').querySelectorAll('[data-native-diff]').forEach((btn) => {
        btn.addEventListener('click', () => {
          vscode.postMessage({
            type: 'openNativeDiff',
            proposalId: btn.getAttribute('data-native-diff'),
          });
        });
      });
    }

    window.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'proposals') {
        render(event.data.payload);
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }

  public dispose(): void {
    this.unsubProposals();
    this.panel?.dispose();
    this.panel = undefined;
  }
}
