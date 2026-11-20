import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { AgentUiSnapshot, PatchPilotController } from "../controller/PatchPilotController";

export const AGENT_VIEW_ID = "patchpilot.agentView";

/**
 * PatchPilot Primary Sidebar Agent Panel (WebviewViewProvider)
 *
 * Displays:
 * - Workspace, TrueForge connection, model, session, turn, MCP & context budget status
 * - Message input with @file / @symbol support, Send & Cancel controls
 * - Live streaming output & chat timeline
 * - Interactive TrueForge tool.approval_required approve/deny cards
 * - Tool activity timeline (separate from natural-language output)
 * - Context assembly summary (files, symbols, rationale, estimated budget)
 * - Proposed change summary bar with Open Diff Review & Undo Last Apply actions
 */
export class AgentViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private readonly unsubUi: () => void;

  constructor(
    private readonly controller: PatchPilotController,
    private readonly openReviewPanel: () => void
  ) {
    this.unsubUi = this.controller.onUiUpdate((snapshot) => {
      this.postState(snapshot);
    });
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg: Record<string, unknown>) => {
      const type = typeof msg?.type === "string" ? msg.type : "";
      switch (type) {
        case "ready": {
          const snap = await this.controller.getUiSnapshot();
          this.postState(snap);
          break;
        }
        case "sendPrompt": {
          const prompt = typeof msg.prompt === "string" ? msg.prompt : "";
          await this.controller.startAgentRun(prompt, {
            onProposalsReady: () => this.openReviewPanel(),
          });
          break;
        }
        case "cancelRun": {
          await this.controller.cancelActiveRun();
          break;
        }
        case "approveTool": {
          const toolCallId = typeof msg.toolCallId === "string" ? msg.toolCallId : "";
          if (toolCallId) {
            await this.controller.respondToApproval(toolCallId, true);
          }
          break;
        }
        case "denyTool": {
          const toolCallId = typeof msg.toolCallId === "string" ? msg.toolCallId : "";
          const reason = typeof msg.reason === "string" ? msg.reason : undefined;
          if (toolCallId) {
            await this.controller.respondToApproval(toolCallId, false, reason);
          }
          break;
        }
        case "openReview": {
          this.openReviewPanel();
          break;
        }
        case "discardProposals": {
          await this.controller.discardProposals();
          break;
        }
        case "undoLastApply": {
          await this.controller.undoLastApply();
          break;
        }
        case "checkTrueForge": {
          await this.controller.checkTrueForge();
          break;
        }
        case "configureTrueForge": {
          await this.controller.configureTrueForge();
          break;
        }
        case "selectWorkspace": {
          await this.controller.selectWorkspaceFolder();
          break;
        }
        case "newSession": {
          this.controller.resetSession();
          break;
        }
        case "showOutput": {
          await vscode.commands.executeCommand("patchpilot.showSession");
          break;
        }
      }
    });

    webviewView.onDidDispose(() => {
      this.view = undefined;
    });

    void this.controller.getUiSnapshot().then((snap) => this.postState(snap));
  }

  public focus(): void {
    if (this.view) {
      this.view.show(true);
    } else {
      void vscode.commands.executeCommand(`${AGENT_VIEW_ID}.focus`);
    }
  }

  private postState(snapshot: AgentUiSnapshot): void {
    if (!this.view) {
      return;
    }
    void this.view.webview.postMessage({ type: "state", payload: snapshot });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString("hex");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
  <title>PatchPilot Agent</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: light dark;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 10px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      display: flex;
      flex-direction: column;
      gap: 10px;
      height: 100vh;
    }
    .card {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
      border-radius: 6px;
      padding: 8px 10px;
    }
    .header-grid {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 6px;
      align-items: center;
    }
    .title {
      font-weight: 600;
      font-size: 13px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .badge {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 500;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .badge.ok { background: #1e6f43; color: #ffffff; }
    .badge.warn { background: #8a5a00; color: #ffffff; }
    .badge.err { background: #9b2226; color: #ffffff; }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 4px 8px;
      margin-top: 6px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .meta-item strong { color: var(--vscode-foreground); font-weight: 600; }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }
    button {
      font-family: inherit;
      font-size: 12px;
      padding: 4px 9px;
      border-radius: 4px;
      border: 1px solid transparent;
      cursor: pointer;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    button:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground);
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    button.secondary:hover:not(:disabled) {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    button.danger {
      background: #9b2226;
      color: #ffffff;
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .scroll-area {
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-height: 120px;
    }
    .section-title {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .msg {
      padding: 8px;
      border-radius: 5px;
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.45;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
    }
    .msg.user { background: var(--vscode-input-background); }
    .msg.assistant { background: var(--vscode-editor-background); }
    .msg.system {
      background: transparent;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      border-style: dashed;
    }
    .msg.error {
      border-color: var(--vscode-inputValidation-errorBorder, #be1100);
      background: var(--vscode-inputValidation-errorBackground, rgba(190,17,0,0.12));
    }
    .msg-role {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      margin-bottom: 3px;
      color: var(--vscode-descriptionForeground);
    }
    .approval-card {
      border: 1px solid #c98a00;
      background: rgba(201, 138, 0, 0.12);
      border-radius: 6px;
      padding: 8px;
      margin-bottom: 6px;
    }
    pre.code {
      margin: 5px 0;
      padding: 6px;
      border-radius: 4px;
      background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.2));
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      overflow-x: auto;
      max-height: 120px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .tool-item {
      border-left: 3px solid var(--vscode-textLink-foreground);
      padding: 4px 8px;
      margin-bottom: 6px;
      font-size: 11px;
      background: var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.08));
      border-radius: 0 4px 4px 0;
    }
    .tool-item.error, .tool-item.denied { border-left-color: #c93b3b; }
    .tool-item.awaiting_approval { border-left-color: #c98a00; }
    .tool-item.completed { border-left-color: #2e8b57; }
    .ctx-file {
      font-size: 11px;
      padding: 3px 0;
      border-bottom: 1px solid rgba(128,128,128,0.15);
    }
    .ctx-file:last-child { border-bottom: none; }
    .composer {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    textarea {
      width: 100%;
      min-height: 68px;
      resize: vertical;
      padding: 7px 8px;
      border-radius: 4px;
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.4));
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-family: inherit;
      font-size: 12px;
    }
    textarea:focus {
      outline: 1px solid var(--vscode-focusBorder);
    }
    .composer-actions {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
    }
    .hint {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }
    details summary {
      cursor: pointer;
      font-size: 11px;
      font-weight: 600;
      user-select: none;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="header-grid">
      <div class="title">PatchPilot <span id="connBadge" class="badge">Unchecked</span></div>
      <div id="turnBadge" class="badge">IDLE</div>
    </div>
    <div class="meta-grid">
      <div class="meta-item">Workspace: <strong id="wsName">None</strong></div>
      <div class="meta-item">Model: <strong id="modelName">Not configured</strong></div>
      <div class="meta-item">Agent: <strong id="agentName">-</strong></div>
      <div class="meta-item">MCP: <strong id="mcpState">stopped</strong></div>
      <div class="meta-item">Session: <strong id="sessionId">-</strong></div>
      <div class="meta-item">Turn: <strong id="turnId">-</strong></div>
      <div class="meta-item">Operation: <strong id="curOp">Idle</strong></div>
      <div class="meta-item">Budget: <strong id="budgetText">0 / 16000 est.</strong></div>
    </div>
    <div class="toolbar">
      <button id="btnCheck" class="secondary" title="Check TrueForge connection, models, and MCP status">Check TrueForge</button>
      <button id="btnConfigure" class="secondary" title="Guided TrueForge setup wizard">Configure</button>
      <button id="btnSwitchWs" class="secondary" title="Select active workspace folder">Workspace</button>
      <button id="btnNewSession" class="secondary" title="Start a fresh TrueForge session">New Session</button>
      <button id="btnOutput" class="secondary" title="Open PatchPilot session details and logs">Session Log</button>
    </div>
  </div>

  <div id="approvalsBox" class="card" style="display:none;">
    <div class="section-title">
      <span>Pending TrueForge Tool Approvals</span>
      <span id="approvalCount" class="badge warn">0</span>
    </div>
    <div id="approvalsList"></div>
  </div>

  <div id="proposalsBar" class="card" style="display:none;">
    <div class="section-title">
      <span>Proposed Changes (Review Before Apply)</span>
      <span id="proposalCount" class="badge ok">0 files</span>
    </div>
    <div id="proposalSummary" style="font-size:11px; margin-bottom:6px;"></div>
    <div class="toolbar" style="margin-top:0;">
      <button id="btnReview">Open Diff Review</button>
      <button id="btnDiscard" class="secondary">Discard</button>
      <button id="btnUndo" class="secondary" style="display:none;">Undo Last Apply</button>
    </div>
  </div>

  <div id="undoOnlyBar" class="card" style="display:none;">
    <div class="toolbar" style="margin-top:0; justify-content:space-between; align-items:center;">
      <span id="undoLabel" style="font-size:11px;">Last apply available</span>
      <button id="btnUndoOnly" class="secondary">Undo Last Apply</button>
    </div>
  </div>

  <div class="scroll-area" id="scrollArea">
    <div id="messagesList"></div>
    <div id="streamingCard" class="msg assistant" style="display:none;">
      <div class="msg-role">TrueForge Agent (Streaming...)</div>
      <div id="streamingText"></div>
    </div>

    <details id="toolsDetails" class="card" style="display:none;" open>
      <summary>Tool Activity Timeline (<span id="toolCount">0</span>)</summary>
      <div id="toolsList" style="margin-top:6px;"></div>
    </details>

    <details id="contextDetails" class="card" style="display:none;">
      <summary>Context Assembly Plan (<span id="ctxFilesCount">0</span> files)</summary>
      <div id="contextBody" style="margin-top:6px;"></div>
    </details>
  </div>

  <div class="card composer">
    <textarea id="promptInput" placeholder="Describe your coding task... Use @file:path or @symbol:name, or let TrueForge discover files automatically. (Ctrl+Enter to send)"></textarea>
    <div class="composer-actions">
      <span class="hint">TrueForge Agent Loop • Proposals never write disk until approved</span>
      <div style="display:flex; gap:6px;">
        <button id="btnCancel" class="danger" disabled>Cancel</button>
        <button id="btnSend">Send</button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const el = (id) => document.getElementById(id);
    const esc = (s) => String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    el('btnCheck').addEventListener('click', () => vscode.postMessage({ type: 'checkTrueForge' }));
    el('btnConfigure').addEventListener('click', () => vscode.postMessage({ type: 'configureTrueForge' }));
    el('btnSwitchWs').addEventListener('click', () => vscode.postMessage({ type: 'selectWorkspace' }));
    el('btnNewSession').addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
    el('btnOutput').addEventListener('click', () => vscode.postMessage({ type: 'showOutput' }));
    el('btnReview').addEventListener('click', () => vscode.postMessage({ type: 'openReview' }));
    el('btnDiscard').addEventListener('click', () => vscode.postMessage({ type: 'discardProposals' }));
    el('btnUndo').addEventListener('click', () => vscode.postMessage({ type: 'undoLastApply' }));
    el('btnUndoOnly').addEventListener('click', () => vscode.postMessage({ type: 'undoLastApply' }));
    el('btnCancel').addEventListener('click', () => vscode.postMessage({ type: 'cancelRun' }));

    function sendPrompt() {
      const input = el('promptInput');
      const val = input.value.trim();
      if (!val) return;
      input.value = '';
      vscode.postMessage({ type: 'sendPrompt', prompt: val });
    }

    el('btnSend').addEventListener('click', sendPrompt);
    el('promptInput').addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        sendPrompt();
      } else if (e.key === 'Escape' && !el('btnCancel').disabled) {
        vscode.postMessage({ type: 'cancelRun' });
      }
    });

    function renderState(s) {
      const connBadge = el('connBadge');
      connBadge.textContent = s.diagnosticState === 'UNCHECKED' ? s.connectionStatus : s.diagnosticState;
      connBadge.className = 'badge ' + (s.diagnosticState === 'CONNECTED' ? 'ok' : (s.connectionStatus === 'CONNECTION_FAILED' || s.diagnosticState === 'SERVER_NOT_RUNNING' || s.diagnosticState === 'AUTH_REQUIRED' ? 'err' : 'warn'));

      const turnBadge = el('turnBadge');
      turnBadge.textContent = s.turnStatus;
      turnBadge.className = 'badge ' + (s.turnStatus === 'COMPLETED' ? 'ok' : (s.turnStatus === 'ERROR' ? 'err' : (s.turnStatus === 'RUNNING' || s.turnStatus === 'PAUSED' ? 'warn' : '')));

      el('wsName').textContent = s.workspaceName ? (s.workspaceTrusted ? s.workspaceName : s.workspaceName + ' (Untrusted)') : 'None';
      el('modelName').textContent = s.selectedModelName || 'Configure in TrueForge';
      el('agentName').textContent = s.configuredAgentName || '-';
      el('mcpState').textContent = s.mcpStatus;
      el('sessionId').textContent = s.activeSessionId ? s.activeSessionId.slice(0, 12) + '…' : '-';
      el('turnId').textContent = s.activeTurnId ? s.activeTurnId.slice(0, 12) + '…' : '-';
      el('curOp').textContent = s.currentOperation || 'Idle';

      const isActive = s.turnStatus === 'RUNNING' || s.turnStatus === 'PAUSED';
      el('btnSend').disabled = isActive;
      el('btnCancel').disabled = !isActive;

      if (s.contextPlan && s.contextPlan.budget) {
        el('budgetText').textContent = s.contextPlan.budget.usedTokens + ' / ' + s.contextPlan.budget.budgetTokens + ' est.';
      }

      // Approvals
      const apprBox = el('approvalsBox');
      if (s.pendingApprovals && s.pendingApprovals.length > 0) {
        apprBox.style.display = 'block';
        el('approvalCount').textContent = String(s.pendingApprovals.length);
        el('approvalsList').innerHTML = s.pendingApprovals.map((a) => \`
          <div class="approval-card">
            <div><strong>Tool:</strong> \${esc(a.toolName)} <span class="badge">\${esc(a.toolCallId.slice(0, 10))}</span></div>
            <pre class="code">\${esc(a.argumentsRaw)}</pre>
            <div class="toolbar" style="margin-top:4px;">
              <button data-approve="\${esc(a.toolCallId)}">Approve Tool Call</button>
              <button class="danger" data-deny="\${esc(a.toolCallId)}">Deny</button>
            </div>
          </div>
        \`).join('');
        el('approvalsList').querySelectorAll('[data-approve]').forEach((btn) => {
          btn.addEventListener('click', () => vscode.postMessage({ type: 'approveTool', toolCallId: btn.getAttribute('data-approve') }));
        });
        el('approvalsList').querySelectorAll('[data-deny]').forEach((btn) => {
          btn.addEventListener('click', () => vscode.postMessage({ type: 'denyTool', toolCallId: btn.getAttribute('data-deny') }));
        });
      } else {
        apprBox.style.display = 'none';
      }

      // Proposals & Undo
      const propBar = el('proposalsBar');
      const undoOnly = el('undoOnlyBar');
      if (s.proposals && s.proposals.length > 0) {
        propBar.style.display = 'block';
        undoOnly.style.display = 'none';
        const totalHunks = s.proposals.reduce((sum, p) => sum + p.hunks.length, 0);
        el('proposalCount').textContent = s.proposals.length + ' file(s), ' + totalHunks + ' hunk(s)';
        el('proposalSummary').innerHTML = s.proposals.map((p) => '<div>• ' + esc(p.relativePath) + ' (' + p.hunks.length + ' hunks, ' + esc(p.status) + ')</div>').join('');
        el('btnUndo').style.display = s.canUndo ? 'inline-block' : 'none';
      } else {
        propBar.style.display = 'none';
        if (s.canUndo) {
          undoOnly.style.display = 'block';
          el('undoLabel').textContent = 'Applied: ' + (s.lastUndoLabel || 'ready to undo');
        } else {
          undoOnly.style.display = 'none';
        }
      }

      // Messages
      el('messagesList').innerHTML = (s.messages || []).map((m) => \`
        <div class="msg \${esc(m.role)}">
          <div class="msg-role">\${esc(m.role)}\${m.modelName ? ' • ' + esc(m.modelName) : ''}</div>
          <div>\${esc(m.content)}</div>
        </div>
      \`).join('');

      // Streaming
      const streamCard = el('streamingCard');
      if (s.streamingText) {
        streamCard.style.display = 'block';
        el('streamingText').textContent = s.streamingText;
      } else {
        streamCard.style.display = 'none';
      }

      // Tool activity
      const toolsDetails = el('toolsDetails');
      if (s.toolActivity && s.toolActivity.length > 0) {
        toolsDetails.style.display = 'block';
        el('toolCount').textContent = String(s.toolActivity.length);
        el('toolsList').innerHTML = s.toolActivity.map((t) => \`
          <div class="tool-item \${esc(t.status)}">
            <div><strong>\${esc(t.toolName)}</strong> <span class="badge">\${esc(t.status)}</span></div>
            <pre class="code">\${esc(t.argumentsPreview)}</pre>
            \${t.resultPreview ? '<pre class="code">' + esc(t.resultPreview) + '</pre>' : ''}
          </div>
        \`).join('');
      } else {
        toolsDetails.style.display = 'none';
      }

      // Context Plan
      const ctxDetails = el('contextDetails');
      if (s.contextPlan) {
        ctxDetails.style.display = 'block';
        el('ctxFilesCount').textContent = String(s.contextPlan.selectedFiles.length);
        const unkHtml = (s.contextPlan.unknownReferences || []).length > 0
          ? '<div style="color:#e06c75;font-size:11px;margin-bottom:4px;">Unresolved: ' + s.contextPlan.unknownReferences.map((u) => esc(u.reference)).join(', ') + '</div>'
          : '';
        const filesHtml = (s.contextPlan.selectedFiles || []).map((f) => \`
          <div class="ctx-file">
            <strong>\${esc(f.relativePath)}</strong> <span class="badge">\${esc(f.source)}</span> (~<span>\${f.estimatedTokens}</span> est. tokens)
            <div style="color:var(--vscode-descriptionForeground);">\${esc(f.reason)}</div>
          </div>
        \`).join('');
        el('contextBody').innerHTML =
          '<div style="font-size:10px;color:var(--vscode-descriptionForeground);margin-bottom:4px;">' + esc(s.contextPlan.budget.estimationMethod) + '</div>' +
          unkHtml + filesHtml;
      } else {
        ctxDetails.style.display = 'none';
      }
    }

    window.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'state') {
        renderState(event.data.payload);
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }

  public dispose(): void {
    this.unsubUi();
  }
}
