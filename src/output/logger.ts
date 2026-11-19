import * as vscode from "vscode";
import { sanitizeSecretText } from "../security/secretFilter";

export interface ILogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
  debug(message: string): void;
  streamChunk(chunk: string): void;
  show(preserveFocus?: boolean): void;
  clear(): void;
  dispose(): void;
}

/**
 * Sanitizes log output to ensure access tokens and sensitive credentials are never written to logs.
 */
export function sanitizeLog(text: string): string {
  return sanitizeSecretText(text);
}

export class PatchPilotLogger implements ILogger {
  private outputChannel: vscode.OutputChannel;
  private isDisposed = false;

  constructor(outputChannel?: vscode.OutputChannel) {
    this.outputChannel = outputChannel ?? vscode.window.createOutputChannel("PatchPilot");
  }

  private formatMessage(level: string, message: string): string {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${level}] ${sanitizeLog(message)}`;
  }

  public info(message: string): void {
    if (this.isDisposed) {
      return;
    }
    this.outputChannel.appendLine(this.formatMessage("INFO", message));
  }

  public warn(message: string): void {
    if (this.isDisposed) {
      return;
    }
    this.outputChannel.appendLine(this.formatMessage("WARN", message));
  }

  public error(message: string, error?: unknown): void {
    if (this.isDisposed) {
      return;
    }
    let fullMsg = message;
    if (error !== undefined) {
      const errorDetail = error instanceof Error ? error.stack || error.message : String(error);
      fullMsg = `${message} - Details: ${errorDetail}`;
    }
    this.outputChannel.appendLine(this.formatMessage("ERROR", fullMsg));
  }

  public debug(message: string): void {
    if (this.isDisposed) {
      return;
    }
    this.outputChannel.appendLine(this.formatMessage("DEBUG", message));
  }

  public streamChunk(chunk: string): void {
    if (this.isDisposed) {
      return;
    }
    // Stream chunks directly without timestamp prefixes
    this.outputChannel.append(sanitizeLog(chunk));
  }

  public show(preserveFocus = true): void {
    if (this.isDisposed) {
      return;
    }
    this.outputChannel.show(preserveFocus);
  }

  public clear(): void {
    if (this.isDisposed) {
      return;
    }
    this.outputChannel.clear();
  }

  public dispose(): void {
    if (!this.isDisposed) {
      this.isDisposed = true;
      this.outputChannel.dispose();
    }
  }
}
