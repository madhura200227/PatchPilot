import * as vscode from "vscode";
import { ILogger } from "../output/logger";

export class MockSecretStorage implements vscode.SecretStorage {
  private secrets = new Map<string, string>();
  private readonly _onDidChange = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();
  public readonly onDidChange: vscode.Event<vscode.SecretStorageChangeEvent> = this._onDidChange.event;

  public async get(key: string): Promise<string | undefined> {
    return this.secrets.get(key);
  }

  public async store(key: string, value: string): Promise<void> {
    this.secrets.set(key, value);
    this._onDidChange.fire({ key });
  }

  public async delete(key: string): Promise<void> {
    this.secrets.delete(key);
    this._onDidChange.fire({ key });
  }

  public async keys(): Promise<string[]> {
    return Array.from(this.secrets.keys());
  }
}

export class MockLogger implements ILogger {
  public logs: string[] = [];
  public streamedChunks: string[] = [];
  public isShown = false;
  public isDisposed = false;

  public info(message: string): void {
    this.logs.push(`[INFO] ${message}`);
  }

  public warn(message: string): void {
    this.logs.push(`[WARN] ${message}`);
  }

  public error(message: string, error?: unknown): void {
    this.logs.push(`[ERROR] ${message} ${error ? String(error) : ""}`);
  }

  public debug(message: string): void {
    this.logs.push(`[DEBUG] ${message}`);
  }

  public streamChunk(chunk: string): void {
    this.streamedChunks.push(chunk);
  }

  public show(preserveFocus?: boolean): void {
    this.isShown = true;
  }

  public clear(): void {
    this.logs = [];
    this.streamedChunks = [];
  }

  public dispose(): void {
    this.isDisposed = true;
  }
}

export function createMockExtensionContext(): vscode.ExtensionContext {
  const secretStorage = new MockSecretStorage();
  const subscriptions: { dispose(): unknown }[] = [];

  return {
    subscriptions,
    secrets: secretStorage,
    extensionUri: vscode.Uri.file("."),
    extensionPath: ".",
    storagePath: "./.patchpilot",
    globalStoragePath: "./.patchpilot/global",
    logPath: "./.patchpilot/logs",
    asAbsolutePath: (rel: string) => rel,
    workspaceState: {
      get: () => undefined,
      update: async () => {},
      keys: () => [],
    },
    globalState: {
      get: () => undefined,
      update: async () => {},
      keys: () => [],
      setKeysForSync: () => {},
    },
  } as unknown as vscode.ExtensionContext;
}
