import * as fs from "node:fs";
import * as path from "node:path";
import {
  ALLOWED_EXTENSIONS,
  MAX_FILE_SIZE_BYTES,
  PROTECTED_DIRECTORIES,
  isBinaryBuffer,
  resolveCanonicalWorkspaceRoot,
  resolveSafeWorkspacePath,
} from "../security/pathGuard";
import { isSensitiveFilePath } from "../security/secretFilter";

/**
 * PatchPilot Deterministic Workspace Symbol Resolver
 *
 * Resolves symbol definitions across Python, TypeScript/JavaScript, and documentation files.
 * Supports an optional VS Code workspace symbol provider callback when running inside the
 * VS Code extension host, with automatic deterministic lexical fallback.
 */

export type ResolvedSymbolKind =
  | "function"
  | "class"
  | "method"
  | "interface"
  | "type"
  | "variable"
  | "heading"
  | "other";

export interface ResolvedSymbolMatch {
  name: string;
  kind: ResolvedSymbolKind;
  relativePath: string;
  startLine: number;
  endLine: number;
  signature: string;
  snippet: string;
  source: "vscode" | "lexical";
}

export interface ExternalSymbolHint {
  name: string;
  kind: ResolvedSymbolKind;
  relativePath: string;
  startLine: number;
  endLine?: number;
}

export type ExternalSymbolLookupFn = (query: string) => Promise<ExternalSymbolHint[]>;

const MAX_SNIPPET_LINES = 80;
const MAX_SCAN_FILES = 1500;

export function enumerateEligibleFiles(workspaceRoot: string, maxFiles: number = MAX_SCAN_FILES): string[] {
  const rootReal = resolveCanonicalWorkspaceRoot(workspaceRoot);
  const files: string[] = [];

  const walk = (currentDir: string): void => {
    if (files.length >= maxFiles) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (files.length >= maxFiles) {
        return;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }

      const fullPath = path.join(currentDir, entry.name);
      const rel = path.relative(rootReal, fullPath).replace(/\\/g, "/");

      if (entry.isDirectory()) {
        if (PROTECTED_DIRECTORIES.has(entry.name.toLowerCase()) || entry.name.startsWith(".")) {
          continue;
        }
        walk(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (isSensitiveFilePath(rel)) {
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        continue;
      }

      try {
        const stat = fs.statSync(fullPath);
        if (stat.size <= MAX_FILE_SIZE_BYTES) {
          files.push(rel);
        }
      } catch {
        // Ignore unreadable file
      }
    }
  };

  walk(rootReal);
  return files;
}

function extractBlockEndLine(lines: string[], startIdx: number, isPython: boolean): number {
  const maxEnd = Math.min(lines.length - 1, startIdx + MAX_SNIPPET_LINES - 1);

  if (isPython) {
    const startLine = lines[startIdx];
    const baseIndent = startLine.length - startLine.trimStart().length;
    let endIdx = startIdx;

    for (let i = startIdx + 1; i <= maxEnd; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      const indent = line.length - line.trimStart().length;
      if (indent <= baseIndent && !trimmed.startsWith("#") && !trimmed.startsWith("@")) {
        break;
      }
      endIdx = i;
    }
    return endIdx;
  }

  // Brace-delimited languages (TS/JS/C/Go/Rust/Java)
  let braceDepth = 0;
  let seenOpenBrace = false;
  let endIdx = startIdx;

  for (let i = startIdx; i <= maxEnd; i++) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === "{") {
        braceDepth++;
        seenOpenBrace = true;
      } else if (ch === "}") {
        braceDepth--;
      }
    }
    endIdx = i;
    if (seenOpenBrace && braceDepth <= 0) {
      break;
    }
    if (!seenOpenBrace && i > startIdx + 10) {
      break;
    }
  }

  return endIdx;
}

function extractSymbolsFromText(
  relativePath: string,
  content: string,
  queryLower: string
): ResolvedSymbolMatch[] {
  const matches: ResolvedSymbolMatch[] = [];
  const ext = path.extname(relativePath).toLowerCase();
  const isPython = ext === ".py" || ext === ".pyi";
  const isDoc = ext === ".md" || ext === ".rst";
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let symbolName: string | undefined;
    let kind: ResolvedSymbolKind = "other";

    if (isPython) {
      const pyFunc = line.match(/^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
      const pyClass = line.match(/^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
      if (pyFunc) {
        symbolName = pyFunc[1];
        kind = line.startsWith(" ") || line.startsWith("\t") ? "method" : "function";
      } else if (pyClass) {
        symbolName = pyClass[1];
        kind = "class";
      }
    } else if (isDoc) {
      const mdHeading = line.match(/^#{1,4}\s+(.+)$/);
      if (mdHeading) {
        symbolName = mdHeading[1].trim();
        kind = "heading";
      } else if (i + 1 < lines.length && /^[=\-~^"`#*+]{3,}$/.test(lines[i + 1].trim()) && line.trim().length > 0) {
        symbolName = line.trim();
        kind = "heading";
      }
    } else {
      const tsFunc = line.match(
        /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[<(]/
      );
      const tsClass = line.match(/^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/);
      const tsIface = line.match(/^\s*(?:export\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/);
      const tsType = line.match(/^\s*(?:export\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/);
      const tsVar = line.match(
        /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\(|function\b|[A-Za-z_])/
      );
      const tsMethod = line.match(
        /^\s+(?:public|private|protected|static|readonly|async|\s)*([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{/
      );

      if (tsFunc) {
        symbolName = tsFunc[1];
        kind = "function";
      } else if (tsClass) {
        symbolName = tsClass[1];
        kind = "class";
      } else if (tsIface) {
        symbolName = tsIface[1];
        kind = "interface";
      } else if (tsType) {
        symbolName = tsType[1];
        kind = "type";
      } else if (tsVar) {
        symbolName = tsVar[1];
        kind = "variable";
      } else if (tsMethod && !["if", "for", "while", "switch", "catch", "constructor"].includes(tsMethod[1])) {
        symbolName = tsMethod[1];
        kind = "method";
      }
    }

    if (!symbolName) {
      continue;
    }

    const symLower = symbolName.toLowerCase();
    if (symLower !== queryLower && !symLower.includes(queryLower)) {
      continue;
    }

    // Include up to 2 preceding decorator lines for Python
    let blockStart = i;
    if (isPython) {
      while (blockStart > 0 && lines[blockStart - 1].trim().startsWith("@")) {
        blockStart--;
      }
    }

    const blockEnd = isDoc
      ? Math.min(lines.length - 1, i + 20)
      : extractBlockEndLine(lines, i, isPython);

    const snippetLines = lines.slice(blockStart, blockEnd + 1).map(
      (l, offset) => `${blockStart + offset + 1}: ${l}`
    );

    matches.push({
      name: symbolName,
      kind,
      relativePath,
      startLine: blockStart + 1,
      endLine: blockEnd + 1,
      signature: line.trim(),
      snippet: snippetLines.join("\n"),
      source: "lexical",
    });
  }

  return matches;
}

/**
 * Resolves a symbol query within workspaceRoot, prioritizing exact matches over partial matches.
 */
export async function resolveWorkspaceSymbol(
  workspaceRoot: string,
  symbolQuery: string,
  options: {
    filePath?: string;
    maxResults?: number;
    externalLookup?: ExternalSymbolLookupFn;
  } = {}
): Promise<ResolvedSymbolMatch[]> {
  const trimmed = symbolQuery.trim();
  if (!trimmed) {
    return [];
  }

  const rootReal = resolveCanonicalWorkspaceRoot(workspaceRoot);
  const maxResults = Math.min(Math.max(options.maxResults ?? 10, 1), 30);
  const queryLower = trimmed.toLowerCase();
  const collected: ResolvedSymbolMatch[] = [];
  const seenKeys = new Set<string>();

  // 1. Optional VS Code workspace symbol provider lookup first
  if (options.externalLookup) {
    try {
      const hints = await options.externalLookup(trimmed);
      for (const hint of hints) {
        if (collected.length >= maxResults) {
          break;
        }
        try {
          const safePath = resolveSafeWorkspacePath(rootReal, hint.relativePath, {
            checkExtension: true,
            mustExist: true,
          });
          const buf = fs.readFileSync(safePath);
          if (buf.length > MAX_FILE_SIZE_BYTES || isBinaryBuffer(buf)) {
            continue;
          }
          const lines = buf.toString("utf8").split(/\r?\n/);
          const startIdx = Math.max(0, hint.startLine - 1);
          const isPython = safePath.endsWith(".py") || safePath.endsWith(".pyi");
          const endIdx = hint.endLine
            ? Math.min(lines.length - 1, Math.max(startIdx, hint.endLine - 1))
            : extractBlockEndLine(lines, startIdx, isPython);

          const rel = path.relative(rootReal, safePath).replace(/\\/g, "/");
          const key = `${rel}:${startIdx + 1}:${hint.name}`;
          if (seenKeys.has(key)) {
            continue;
          }
          seenKeys.add(key);

          const snippet = lines
            .slice(startIdx, Math.min(endIdx + 1, startIdx + MAX_SNIPPET_LINES))
            .map((l, idx) => `${startIdx + idx + 1}: ${l}`)
            .join("\n");

          collected.push({
            name: hint.name,
            kind: hint.kind,
            relativePath: rel,
            startLine: startIdx + 1,
            endLine: endIdx + 1,
            signature: (lines[startIdx] ?? "").trim(),
            snippet,
            source: "vscode",
          });
        } catch {
          // Skip symbols outside safe workspace boundary
        }
      }
    } catch {
      // Fall back to deterministic lexical search
    }
  }

  // 2. Deterministic lexical scan fallback / supplement
  let targetFiles: string[];
  if (options.filePath) {
    const safeFile = resolveSafeWorkspacePath(rootReal, options.filePath, {
      checkExtension: true,
      mustExist: true,
    });
    targetFiles = [path.relative(rootReal, safeFile).replace(/\\/g, "/")];
  } else {
    targetFiles = enumerateEligibleFiles(rootReal);
  }

  const lexicalMatches: ResolvedSymbolMatch[] = [];
  for (const rel of targetFiles) {
    const full = path.join(rootReal, rel);
    let buf: Buffer;
    try {
      buf = fs.readFileSync(full);
    } catch {
      continue;
    }
    if (isBinaryBuffer(buf)) {
      continue;
    }
    const content = buf.toString("utf8");
    if (!content.toLowerCase().includes(queryLower)) {
      continue;
    }
    const fileMatches = extractSymbolsFromText(rel, content, queryLower);
    for (const m of fileMatches) {
      const key = `${m.relativePath}:${m.startLine}:${m.name}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        lexicalMatches.push(m);
      }
    }
  }

  // Sort exact name matches before substring matches, then by path
  const all = [...collected, ...lexicalMatches].sort((a, b) => {
    const aExact = a.name.toLowerCase() === queryLower ? 0 : 1;
    const bExact = b.name.toLowerCase() === queryLower ? 0 : 1;
    if (aExact !== bExact) {
      return aExact - bExact;
    }
    if (a.source !== b.source) {
      return a.source === "vscode" ? -1 : 1;
    }
    return a.relativePath.localeCompare(b.relativePath) || a.startLine - b.startLine;
  });

  return all.slice(0, maxResults);
}
