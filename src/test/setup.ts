import Module from "module";
import * as fs from "node:fs";

// Mock vscode module for Node-based unit testing (NEVER used for Extension Development Host tests)
class MockEventEmitter<T = unknown> {
  private listeners: ((e: T) => void)[] = [];

  public event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const idx = this.listeners.indexOf(listener);
        if (idx !== -1) {
          this.listeners.splice(idx, 1);
        }
      },
    };
  };

  public fire(data: T): void {
    for (const listener of this.listeners) {
      try {
        listener(data);
      } catch {
        // ignore listener failure
      }
    }
  }

  public dispose(): void {
    this.listeners = [];
  }
}

class MockPosition {
  constructor(public readonly line: number, public readonly character: number) {}
}

class MockRange {
  constructor(public readonly start: MockPosition, public readonly end: MockPosition) {}
}

class MockWorkspaceEdit {
  public readonly ops: Array<{ type: string; uri: { fsPath: string }; text?: string }> = [];
  public createFile(uri: { fsPath: string }): void {
    this.ops.push({ type: "create", uri });
  }
  public insert(uri: { fsPath: string }, _pos: unknown, text: string): void {
    this.ops.push({ type: "insert", uri, text });
  }
  public replace(uri: { fsPath: string }, _range: unknown, text: string): void {
    this.ops.push({ type: "replace", uri, text });
  }
  public deleteFile(uri: { fsPath: string }): void {
    this.ops.push({ type: "delete", uri });
  }
}

const mockCommands = new Map<string, (...args: unknown[]) => unknown>();

const mockOutputChannel = {
  name: "PatchPilot",
  append: () => {},
  appendLine: () => {},
  clear: () => {},
  show: () => {},
  hide: () => {},
  dispose: () => {},
};

const mockStatusBarItem = {
  text: "",
  tooltip: "",
  command: "",
  show: () => {},
  hide: () => {},
  dispose: () => {},
};

const mockWorkspaceConfig = {
  get: <T>(section: string, defaultValue?: T): T => {
    if (section === "baseUrl") return "http://localhost:8790" as unknown as T;
    if (section === "agentName") return "" as unknown as T;
    if (section === "requestTimeoutSeconds") return 30 as unknown as T;
    return defaultValue as T;
  },
  has: () => true,
  inspect: () => undefined,
  update: async () => {},
};

export const mockVscode = {
  EventEmitter: MockEventEmitter,
  Position: MockPosition,
  Range: MockRange,
  WorkspaceEdit: MockWorkspaceEdit,
  ConfigurationTarget: {
    Global: 1,
    Workspace: 2,
    WorkspaceFolder: 3,
  },
  ViewColumn: {
    One: 1,
    Two: 2,
  },
  SymbolKind: {
    Class: 4,
    Method: 5,
    Constructor: 8,
    Interface: 10,
    Function: 11,
    Variable: 12,
    Constant: 13,
    TypeParameter: 25,
  },
  StatusBarAlignment: {
    Left: 1,
    Right: 2,
  },
  ProgressLocation: {
    Notification: 15,
    SourceControl: 1,
    Window: 10,
  },
  Uri: {
    file: (f: string) => ({ fsPath: f, path: f, scheme: "file" }),
    parse: (u: string) => ({ fsPath: u, path: u, scheme: "http", query: u.includes("?") ? u.split("?")[1] : "" }),
  },
  env: {
    clipboard: {
      writeText: async () => {},
    },
    openExternal: async () => true,
  },
  window: {
    activeTextEditor: undefined,
    createOutputChannel: () => mockOutputChannel,
    createStatusBarItem: () => mockStatusBarItem,
    registerWebviewViewProvider: () => ({ dispose: () => {} }),
    createWebviewPanel: () => ({
      webview: {
        html: "",
        postMessage: async () => true,
        onDidReceiveMessage: () => ({ dispose: () => {} }),
      },
      reveal: () => {},
      onDidDispose: () => ({ dispose: () => {} }),
      dispose: () => {},
    }),
    showInformationMessage: async (msg: string) => msg,
    showWarningMessage: async (msg: string) => msg,
    showErrorMessage: async (msg: string) => msg,
    showInputBox: async () => "mock input",
    showQuickPick: async () => undefined,
    withProgress: async (_opts: unknown, task: (p: unknown, token: unknown) => Promise<unknown>) => {
      const token = {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => {} }),
      };
      return task({ report: () => {} }, token);
    },
  },
  commands: {
    registerCommand: (command: string, callback: (...args: unknown[]) => unknown) => {
      mockCommands.set(command, callback);
      return {
        dispose: () => mockCommands.delete(command),
      };
    },
    executeCommand: async (command: string, ...args: unknown[]) => {
      const handler = mockCommands.get(command);
      if (handler) {
        return handler(...args);
      }
      return undefined;
    },
    getCommands: async () => {
      return Array.from(mockCommands.keys());
    },
  },
  workspace: {
    isTrusted: true,
    workspaceFolders: undefined,
    textDocuments: [],
    getConfiguration: () => mockWorkspaceConfig,
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
    onDidGrantWorkspaceTrust: () => ({ dispose: () => {} }),
    registerTextDocumentContentProvider: () => ({ dispose: () => {} }),
    openTextDocument: async (uri: { fsPath: string }) => {
      const text = fs.existsSync(uri.fsPath) ? fs.readFileSync(uri.fsPath, "utf8") : "";
      const lines = text.split(/\r?\n/);
      return {
        uri,
        version: 1,
        lineCount: lines.length,
        lineAt: (idx: number) => ({ text: lines[idx] ?? "" }),
        getText: () => text,
        save: async () => true,
      };
    },
    applyEdit: async (edit: MockWorkspaceEdit) => {
      for (const op of edit.ops) {
        if (op.type === "replace" || op.type === "insert") {
          fs.writeFileSync(op.uri.fsPath, op.text ?? "", "utf8");
        } else if (op.type === "delete") {
          fs.rmSync(op.uri.fsPath, { force: true });
        }
      }
      return true;
    },
  },
};

// Hook require for "vscode"
const originalRequire = (Module.prototype as unknown as { require: (id: string) => unknown }).require;
(Module.prototype as unknown as { require: (id: string) => unknown }).require = function (id: string) {
  if (id === "vscode") {
    return mockVscode;
  }
  return originalRequire.apply(this, arguments as unknown as [string]);
};
