import Module from "module";

// Mock vscode module for Node-based unit testing
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
      } catch {}
    }
  }

  public dispose(): void {
    this.listeners = [];
  }
}

const mockCommands = new Map<string, (...args: unknown[]) => unknown>();

const mockOutputChannel = {
  name: "PatchPilot",
  append: (value: string) => {},
  appendLine: (value: string) => {},
  clear: () => {},
  show: (preserveFocus?: boolean) => {},
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
    parse: (u: string) => ({ fsPath: u, path: u, scheme: "http" }),
  },
  window: {
    createOutputChannel: () => mockOutputChannel,
    createStatusBarItem: () => mockStatusBarItem,
    showInformationMessage: async (msg: string) => msg,
    showWarningMessage: async (msg: string) => msg,
    showErrorMessage: async (msg: string) => msg,
    showInputBox: async (opts?: unknown) => "mock input",
    withProgress: async (opts: unknown, task: (p: unknown, token: unknown) => Promise<unknown>) => {
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
    getCommands: async (filterInternal?: boolean) => {
      return Array.from(mockCommands.keys());
    },
  },
  workspace: {
    getConfiguration: (section?: string) => mockWorkspaceConfig,
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
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
