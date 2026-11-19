import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { ExternalSymbolHint, ExternalSymbolLookupFn, ResolvedSymbolKind } from "../context/symbolResolver";
import { resolveCanonicalWorkspaceRoot } from "../security/pathGuard";
import { WorkspaceFileMutations } from "./undoManager";

/**
 * VS Code WorkspaceEdit-backed file mutations for safe applying & undoing of accepted hunks.
 */
export function createVscodeWorkspaceMutations(): WorkspaceFileMutations {
  return {
    async writeFile(absolutePath: string, content: string, isNewFile: boolean): Promise<void> {
      const uri = vscode.Uri.file(absolutePath);
      const edit = new vscode.WorkspaceEdit();

      if (isNewFile || !fs.existsSync(absolutePath)) {
        edit.createFile(uri, { overwrite: true, ignoreIfExists: false });
        edit.insert(uri, new vscode.Position(0, 0), content);
      } else {
        const doc = await vscode.workspace.openTextDocument(uri);
        const lastLine = Math.max(0, doc.lineCount - 1);
        const lastLineLen = doc.lineAt(lastLine).text.length;
        const fullRange = new vscode.Range(
          new vscode.Position(0, 0),
          new vscode.Position(lastLine, lastLineLen)
        );
        edit.replace(uri, fullRange, content);
      }

      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) {
        throw new Error(`VS Code WorkspaceEdit failed while updating "${absolutePath}".`);
      }

      const docAfter = await vscode.workspace.openTextDocument(uri);
      await docAfter.save();
    },

    async deleteFile(absolutePath: string): Promise<void> {
      const uri = vscode.Uri.file(absolutePath);
      const edit = new vscode.WorkspaceEdit();
      edit.deleteFile(uri, { ignoreIfNotExists: true });
      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied && fs.existsSync(absolutePath)) {
        throw new Error(`VS Code WorkspaceEdit failed while deleting "${absolutePath}".`);
      }
    },
  };
}

function mapVscodeSymbolKind(kind: vscode.SymbolKind): ResolvedSymbolKind {
  switch (kind) {
    case vscode.SymbolKind.Function:
      return "function";
    case vscode.SymbolKind.Class:
      return "class";
    case vscode.SymbolKind.Method:
    case vscode.SymbolKind.Constructor:
      return "method";
    case vscode.SymbolKind.Interface:
      return "interface";
    case vscode.SymbolKind.TypeParameter:
      return "type";
    case vscode.SymbolKind.Variable:
    case vscode.SymbolKind.Constant:
      return "variable";
    default:
      return "other";
  }
}

/**
 * Bridges VS Code's built-in language-server workspace symbol provider into PatchPilot's symbol resolver.
 */
export function createVscodeSymbolLookup(workspaceRoot: string): ExternalSymbolLookupFn {
  const rootReal = resolveCanonicalWorkspaceRoot(workspaceRoot);
  return async (query: string): Promise<ExternalSymbolHint[]> => {
    try {
      const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        "vscode.executeWorkspaceSymbolProvider",
        query
      );
      if (!Array.isArray(symbols) || symbols.length === 0) {
        return [];
      }

      const hints: ExternalSymbolHint[] = [];
      for (const sym of symbols) {
        if (!sym?.location?.uri?.fsPath) {
          continue;
        }
        const rel = path.relative(rootReal, sym.location.uri.fsPath).replace(/\\/g, "/");
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          continue;
        }
        hints.push({
          name: sym.name,
          kind: mapVscodeSymbolKind(sym.kind),
          relativePath: rel,
          startLine: sym.location.range.start.line + 1,
          endLine: sym.location.range.end.line + 1,
        });
      }
      return hints;
    } catch {
      return [];
    }
  };
}
