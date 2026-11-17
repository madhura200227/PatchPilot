import * as vscode from "vscode";

export type ConnectionStatus =
  | "NOT_CONFIGURED"
  | "CONNECTING"
  | "CONNECTED"
  | "CONNECTION_FAILED"
  | "AUTH_REQUIRED";

export type TurnStatus =
  | "IDLE"
  | "RUNNING"
  | "PAUSED"
  | "COMPLETED"
  | "CANCELLED"
  | "ERROR";

export interface ExtensionStateSnapshot {
  connectionStatus: ConnectionStatus;
  connectionDetails?: string;
  activeSessionId?: string;
  activeTurnId?: string;
  turnStatus: TurnStatus;
  lastEventId?: string;
  turnAccumulatedText: string;
  isStartingSession: boolean;
  isSendingMessage: boolean;
  isCancelling: boolean;
  isCheckingConnection: boolean;
}

export class ExtensionState {
  private _connectionStatus: ConnectionStatus = "NOT_CONFIGURED";
  private _connectionDetails?: string;
  private _activeSessionId?: string;
  private _activeTurnId?: string;
  private _turnStatus: TurnStatus = "IDLE";
  private _lastEventId?: string;
  private _turnAccumulatedText = "";
  private _activeAbortController?: AbortController;

  // Concurrency guards
  private _isStartingSession = false;
  private _isSendingMessage = false;
  private _isCancelling = false;
  private _isCheckingConnection = false;

  private readonly _onDidChange = new vscode.EventEmitter<ExtensionStateSnapshot>();
  public readonly onDidChange: vscode.Event<ExtensionStateSnapshot> = this._onDidChange.event;

  // --- Getters ---
  public get connectionStatus(): ConnectionStatus {
    return this._connectionStatus;
  }

  public get connectionDetails(): string | undefined {
    return this._connectionDetails;
  }

  public get activeSessionId(): string | undefined {
    return this._activeSessionId;
  }

  public get activeTurnId(): string | undefined {
    return this._activeTurnId;
  }

  public get turnStatus(): TurnStatus {
    return this._turnStatus;
  }

  public get lastEventId(): string | undefined {
    return this._lastEventId;
  }

  public get turnAccumulatedText(): string {
    return this._turnAccumulatedText;
  }

  public get activeAbortController(): AbortController | undefined {
    return this._activeAbortController;
  }

  public get isStartingSession(): boolean {
    return this._isStartingSession;
  }

  public get isSendingMessage(): boolean {
    return this._isSendingMessage;
  }

  public get isCancelling(): boolean {
    return this._isCancelling;
  }

  public get isCheckingConnection(): boolean {
    return this._isCheckingConnection;
  }

  public getSnapshot(): ExtensionStateSnapshot {
    return {
      connectionStatus: this._connectionStatus,
      connectionDetails: this._connectionDetails,
      activeSessionId: this._activeSessionId,
      activeTurnId: this._activeTurnId,
      turnStatus: this._turnStatus,
      lastEventId: this._lastEventId,
      turnAccumulatedText: this._turnAccumulatedText,
      isStartingSession: this._isStartingSession,
      isSendingMessage: this._isSendingMessage,
      isCancelling: this._isCancelling,
      isCheckingConnection: this._isCheckingConnection,
    };
  }

  private notify(): void {
    this._onDidChange.fire(this.getSnapshot());
  }

  // --- State Mutators ---

  public setConnectionStatus(status: ConnectionStatus, details?: string): void {
    this._connectionStatus = status;
    this._connectionDetails = details;
    this.notify();
  }

  public setActiveSessionId(sessionId?: string): void {
    this._activeSessionId = sessionId;
    if (!sessionId) {
      this._activeTurnId = undefined;
      this._turnStatus = "IDLE";
      this._lastEventId = undefined;
      this._turnAccumulatedText = "";
    }
    this.notify();
  }

  public setActiveTurn(turnId?: string, status: TurnStatus = "RUNNING"): void {
    this._activeTurnId = turnId;
    this._turnStatus = status;
    this._turnAccumulatedText = "";
    this.notify();
  }

  public setTurnStatus(status: TurnStatus): void {
    this._turnStatus = status;
    if (status === "COMPLETED" || status === "CANCELLED" || status === "ERROR") {
      this._activeAbortController = undefined;
    }
    this.notify();
  }

  public setLastEventId(eventId?: string): void {
    this._lastEventId = eventId;
  }

  public appendTurnText(chunk: string): void {
    this._turnAccumulatedText += chunk;
  }

  public setActiveAbortController(controller?: AbortController): void {
    this._activeAbortController = controller;
  }

  // --- Concurrency Guards ---

  public acquireStartSessionGuard(): boolean {
    if (this._isStartingSession) {
      return false;
    }
    this._isStartingSession = true;
    this.notify();
    return true;
  }

  public releaseStartSessionGuard(): void {
    this._isStartingSession = false;
    this.notify();
  }

  public acquireSendMessageGuard(): boolean {
    if (this._isSendingMessage || this._turnStatus === "RUNNING") {
      return false;
    }
    this._isSendingMessage = true;
    this.notify();
    return true;
  }

  public releaseSendMessageGuard(): void {
    this._isSendingMessage = false;
    this.notify();
  }

  public acquireCancelGuard(): boolean {
    if (this._isCancelling) {
      return false;
    }
    this._isCancelling = true;
    this.notify();
    return true;
  }

  public releaseCancelGuard(): void {
    this._isCancelling = false;
    this.notify();
  }

  public acquireCheckConnectionGuard(): boolean {
    if (this._isCheckingConnection) {
      return false;
    }
    this._isCheckingConnection = true;
    this.notify();
    return true;
  }

  public releaseCheckConnectionGuard(): void {
    this._isCheckingConnection = false;
    this.notify();
  }

  /**
   * Generates a human-readable status badge string for the VS Code status bar.
   */
  public getStatusBarText(): string {
    if (this._turnStatus === "RUNNING") {
      return "$(sync~spin) PatchPilot: Turn running";
    }
    if (this._turnStatus === "PAUSED") {
      return "$(debug-pause) PatchPilot: Turn paused";
    }
    if (this._turnStatus === "COMPLETED") {
      return "$(check) PatchPilot: Turn completed";
    }
    if (this._turnStatus === "CANCELLED") {
      return "$(circle-slash) PatchPilot: Turn cancelled";
    }
    if (this._turnStatus === "ERROR") {
      return "$(error) PatchPilot: Turn error";
    }

    switch (this._connectionStatus) {
      case "NOT_CONFIGURED":
        return "$(gear) PatchPilot: Not configured";
      case "CONNECTING":
        return "$(sync~spin) PatchPilot: Connecting...";
      case "CONNECTED":
        return this._activeSessionId
          ? "$(plug) PatchPilot: Session active"
          : "$(plug) PatchPilot: Connected";
      case "CONNECTION_FAILED":
        return "$(error) PatchPilot: Connection failed";
      case "AUTH_REQUIRED":
        return "$(key) PatchPilot: Authentication required";
      default:
        return "$(hubot) PatchPilot";
    }
  }

  public dispose(): void {
    this._onDidChange.dispose();
  }
}
