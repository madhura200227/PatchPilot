/**
 * PatchPilot TrueForge Domain Errors
 */

export class PatchPilotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchPilotError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class TrueForgeConnectionError extends PatchPilotError {
  public readonly serverUrl: string;
  public readonly originalError?: unknown;

  constructor(message: string, serverUrl: string, originalError?: unknown) {
    super(message);
    this.name = "TrueForgeConnectionError";
    this.serverUrl = serverUrl;
    this.originalError = originalError;
  }
}

export class TrueForgeAuthError extends PatchPilotError {
  public readonly serverUrl: string;
  public readonly statusCode?: number;

  constructor(message: string, serverUrl: string, statusCode?: number) {
    super(message);
    this.name = "TrueForgeAuthError";
    this.serverUrl = serverUrl;
    this.statusCode = statusCode;
  }
}

export class TrueForgeConfigurationError extends PatchPilotError {
  public readonly configKey?: string;

  constructor(message: string, configKey?: string) {
    super(message);
    this.name = "TrueForgeConfigurationError";
    this.configKey = configKey;
  }
}

export class TrueForgeSessionError extends PatchPilotError {
  public readonly sessionId?: string;

  constructor(message: string, sessionId?: string, originalError?: unknown) {
    super(message);
    this.name = "TrueForgeSessionError";
    this.sessionId = sessionId;
  }
}

export class TrueForgeStreamError extends PatchPilotError {
  public readonly sessionId: string;
  public readonly turnId?: string;
  public readonly lastEventId?: string;

  constructor(message: string, sessionId: string, turnId?: string, lastEventId?: string) {
    super(message);
    this.name = "TrueForgeStreamError";
    this.sessionId = sessionId;
    this.turnId = turnId;
    this.lastEventId = lastEventId;
  }
}

export class TrueForgeCancellationError extends PatchPilotError {
  public readonly sessionId: string;
  public readonly turnId?: string;

  constructor(message: string, sessionId: string, turnId?: string) {
    super(message);
    this.name = "TrueForgeCancellationError";
    this.sessionId = sessionId;
    this.turnId = turnId;
  }
}

export class TrueForgeTurnError extends PatchPilotError {
  public readonly sessionId: string;
  public readonly turnId: string;
  public readonly serverReason?: string;

  constructor(message: string, sessionId: string, turnId: string, serverReason?: string) {
    super(message);
    this.name = "TrueForgeTurnError";
    this.sessionId = sessionId;
    this.turnId = turnId;
    this.serverReason = serverReason;
  }
}

export class TrueForgeUnsupportedEventError extends PatchPilotError {
  public readonly eventType: string;

  constructor(eventType: string, message?: string) {
    super(
      message ??
        `Encountered unsupported TrueForge event type '${eventType}' in Milestone 0. Tool approvals and interactive responses are not supported in this milestone.`
    );
    this.name = "TrueForgeUnsupportedEventError";
    this.eventType = eventType;
  }
}
