import * as fs from "node:fs";
import * as path from "node:path";
import {
  resolveCanonicalWorkspaceRoot,
  safeReadWorkspaceTextFile,
} from "../security/pathGuard";
import { parseMentions } from "./mentionParser";
import { searchAndRankWorkspace, RankedSnippet } from "./relevanceRanker";
import {
  enumerateEligibleFiles,
  ExternalSymbolLookupFn,
  ResolvedSymbolKind,
  resolveWorkspaceSymbol,
} from "./symbolResolver";
import {
  ContextBudgetSnapshot,
  ContextBudgetTracker,
  DEFAULT_CONTEXT_TOKEN_BUDGET,
  estimateTokens,
  truncateTextToTokenBudget,
} from "./tokenBudget";

/**
 * PatchPilot Deterministic Context Assembly Engine
 *
 * Combines explicit @file / @symbol mentions with BM25 automatic retrieval
 * under a configurable estimated token budget (default 16,000 token-equivalents),
 * producing a transparent ContextPlan exposed to both the UI and MCP get_context_plan.
 */

export interface SelectedContextFile {
  relativePath: string;
  source: "explicit_file" | "explicit_symbol" | "auto_retrieval";
  reason: string;
  score?: number;
  estimatedTokens: number;
  truncated: boolean;
  snippets: RankedSnippet[];
}

export interface SelectedContextSymbol {
  name: string;
  kind: ResolvedSymbolKind;
  relativePath: string;
  startLine: number;
  endLine: number;
  source: "vscode" | "lexical";
  reason: string;
  estimatedTokens: number;
}

export interface UnknownContextReference {
  kind: "file" | "symbol";
  reference: string;
  reason: string;
}

export interface ContextPlan {
  query: string;
  workspaceRootName: string;
  explicitFileMentions: string[];
  explicitSymbolMentions: string[];
  selectedFiles: SelectedContextFile[];
  selectedSymbols: SelectedContextSymbol[];
  unknownReferences: UnknownContextReference[];
  workspaceOverview: string[];
  budget: ContextBudgetSnapshot;
}

export interface AssembleContextOptions {
  tokenBudget?: number;
  maxAutoFiles?: number;
  externalSymbolLookup?: ExternalSymbolLookupFn;
  explicitFiles?: string[];
  explicitSymbols?: string[];
}

function buildWorkspaceOverview(workspaceRoot: string, maxEntries: number = 40): string[] {
  const files = enumerateEligibleFiles(workspaceRoot, 500);
  const topDirs = new Map<string, number>();
  const topFiles: string[] = [];

  for (const rel of files) {
    const parts = rel.split("/");
    if (parts.length === 1) {
      topFiles.push(rel);
    } else {
      const dir = parts[0];
      topDirs.set(dir, (topDirs.get(dir) ?? 0) + 1);
    }
  }

  const overview: string[] = [];
  for (const [dir, count] of Array.from(topDirs.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    overview.push(`${dir}/ (${count} eligible files)`);
  }
  for (const f of topFiles.sort()) {
    overview.push(f);
  }
  return overview.slice(0, maxEntries);
}

/**
 * Assembles a deterministic, budgeted context plan for a user query.
 */
export async function assembleWorkspaceContext(
  workspaceRoot: string,
  userPrompt: string,
  options: AssembleContextOptions = {}
): Promise<ContextPlan> {
  const rootReal = resolveCanonicalWorkspaceRoot(workspaceRoot);
  const tracker = new ContextBudgetTracker(options.tokenBudget ?? DEFAULT_CONTEXT_TOKEN_BUDGET);
  const parsed = parseMentions(userPrompt);

  const fileMentions = Array.from(
    new Set([...parsed.fileMentions, ...(options.explicitFiles ?? [])])
  );
  const symbolMentions = Array.from(
    new Set([...parsed.symbolMentions, ...(options.explicitSymbols ?? [])])
  );

  // 1. Account for the user's request first
  tracker.forceRecord("userRequest", estimateTokens(parsed.cleanedPrompt));

  const selectedFiles: SelectedContextFile[] = [];
  const selectedSymbols: SelectedContextSymbol[] = [];
  const unknownReferences: UnknownContextReference[] = [];
  const includedFileSet = new Set<string>();

  // 2. Resolve explicit @file mentions (highest context priority)
  for (const rawFile of fileMentions) {
    try {
      const fileData = await safeReadWorkspaceTextFile(rootReal, rawFile);
      if (includedFileSet.has(fileData.relativePath)) {
        continue;
      }

      const remaining = tracker.getRemainingTokens();
      const maxForFile = Math.min(remaining, Math.floor(tracker.getBudgetTokens() * 0.4));
      if (maxForFile < 32) {
        tracker.recordExclusion({
          relativePath: fileData.relativePath,
          reason: "Insufficient remaining context budget for explicit @file mention",
          originalEstimatedTokens: estimateTokens(fileData.content),
          keptEstimatedTokens: 0,
        });
        continue;
      }

      const trunc = truncateTextToTokenBudget(fileData.content, maxForFile);
      tracker.allocate("explicitFiles", trunc.keptTokens);

      if (trunc.truncated) {
        tracker.recordExclusion({
          relativePath: fileData.relativePath,
          reason: "Truncated explicit @file mention to fit context budget",
          originalEstimatedTokens: trunc.originalTokens,
          keptEstimatedTokens: trunc.keptTokens,
        });
      }

      const totalLines = fileData.content.split(/\r?\n/).length;
      includedFileSet.add(fileData.relativePath);
      selectedFiles.push({
        relativePath: fileData.relativePath,
        source: "explicit_file",
        reason: `Explicitly referenced via @file (${rawFile})`,
        estimatedTokens: trunc.keptTokens,
        truncated: trunc.truncated,
        snippets: [
          {
            startLine: 1,
            endLine: totalLines,
            content: trunc.text,
            matchedTerms: [rawFile],
          },
        ],
      });
    } catch (err: unknown) {
      unknownReferences.push({
        kind: "file",
        reference: rawFile,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 3. Resolve explicit @symbol mentions
  for (const symQuery of symbolMentions) {
    const matches = await resolveWorkspaceSymbol(rootReal, symQuery, {
      maxResults: 3,
      externalLookup: options.externalSymbolLookup,
    });

    if (matches.length === 0) {
      unknownReferences.push({
        kind: "symbol",
        reference: symQuery,
        reason: `Symbol "${symQuery}" was not found in eligible workspace files.`,
      });
      continue;
    }

    for (const m of matches) {
      const remaining = tracker.getRemainingTokens();
      const maxForSym = Math.min(remaining, Math.floor(tracker.getBudgetTokens() * 0.25));
      if (maxForSym < 24) {
        tracker.recordExclusion({
          relativePath: `${m.relativePath}#${m.name}`,
          reason: "Insufficient remaining context budget for @symbol match",
          originalEstimatedTokens: estimateTokens(m.snippet),
          keptEstimatedTokens: 0,
        });
        continue;
      }

      const trunc = truncateTextToTokenBudget(m.snippet, maxForSym);
      tracker.allocate("explicitSymbols", trunc.keptTokens);

      selectedSymbols.push({
        name: m.name,
        kind: m.kind,
        relativePath: m.relativePath,
        startLine: m.startLine,
        endLine: m.endLine,
        source: m.source,
        reason: `Explicitly referenced via @symbol (${symQuery})`,
        estimatedTokens: trunc.keptTokens,
      });

      if (!includedFileSet.has(m.relativePath)) {
        includedFileSet.add(m.relativePath);
        selectedFiles.push({
          relativePath: m.relativePath,
          source: "explicit_symbol",
          reason: `Contains referenced symbol "${m.name}" (${m.kind}, lines ${m.startLine}-${m.endLine})`,
          estimatedTokens: trunc.keptTokens,
          truncated: trunc.truncated,
          snippets: [
            {
              startLine: m.startLine,
              endLine: m.endLine,
              content: trunc.text,
              matchedTerms: [m.name],
            },
          ],
        });
      }
    }
  }

  // 4. Workspace structure overview
  const workspaceOverview = buildWorkspaceOverview(rootReal, 35);
  const overviewTokens = estimateTokens(workspaceOverview.join("\n"));
  tracker.allocate("workspaceStructure", Math.min(overviewTokens, tracker.getRemainingTokens()));

  // 5. Automatic deterministic BM25 retrieval (deduplicated against already-included files)
  const maxAutoFiles = options.maxAutoFiles ?? 8;
  const ranked = searchAndRankWorkspace(rootReal, parsed.cleanedPrompt, {
    maxResults: maxAutoFiles + includedFileSet.size + 4,
    maxSnippetsPerFile: 3,
  });

  let autoCount = 0;
  for (const item of ranked) {
    if (includedFileSet.has(item.relativePath)) {
      continue;
    }

    const combinedSnippetText = item.snippets.map((s) => s.content).join("\n---\n");
    const rawTokens = estimateTokens(combinedSnippetText);

    if (autoCount >= maxAutoFiles) {
      tracker.recordExclusion({
        relativePath: item.relativePath,
        reason: `Exceeded top-${maxAutoFiles} automatic retrieval cap (score=${item.score})`,
        originalEstimatedTokens: rawTokens,
        keptEstimatedTokens: 0,
      });
      continue;
    }

    const remaining = tracker.getRemainingTokens();
    const maxForSnippet = Math.min(remaining, Math.floor(tracker.getBudgetTokens() * 0.2));
    if (maxForSnippet < 40) {
      tracker.recordExclusion({
        relativePath: item.relativePath,
        reason: "Excluded to stay within configured context token budget",
        originalEstimatedTokens: rawTokens,
        keptEstimatedTokens: 0,
      });
      continue;
    }

    const keptSnippets: RankedSnippet[] = [];
    let fileTokens = 0;
    let fileTruncated = false;

    for (const snip of item.snippets) {
      const avail = maxForSnippet - fileTokens;
      if (avail < 24) {
        fileTruncated = true;
        break;
      }
      const trunc = truncateTextToTokenBudget(snip.content, avail);
      fileTokens += trunc.keptTokens;
      if (trunc.truncated) {
        fileTruncated = true;
      }
      keptSnippets.push({
        startLine: snip.startLine,
        endLine: snip.endLine,
        content: trunc.text,
        matchedTerms: snip.matchedTerms,
      });
    }

    if (fileTokens === 0) {
      continue;
    }

    tracker.allocate("retrievedSnippets", fileTokens);
    if (fileTruncated) {
      tracker.recordExclusion({
        relativePath: item.relativePath,
        reason: "Truncated retrieved snippets to fit context budget",
        originalEstimatedTokens: rawTokens,
        keptEstimatedTokens: fileTokens,
      });
    }

    includedFileSet.add(item.relativePath);
    autoCount++;
    selectedFiles.push({
      relativePath: item.relativePath,
      source: "auto_retrieval",
      reason: item.reason,
      score: item.score,
      estimatedTokens: fileTokens,
      truncated: fileTruncated,
      snippets: keptSnippets,
    });
  }

  return {
    query: parsed.cleanedPrompt,
    workspaceRootName: path.basename(rootReal) || fs.realpathSync(rootReal),
    explicitFileMentions: fileMentions,
    explicitSymbolMentions: symbolMentions,
    selectedFiles,
    selectedSymbols,
    unknownReferences,
    workspaceOverview,
    budget: tracker.getSnapshot(),
  };
}

/**
 * Formats a concise human/model-readable summary of a ContextPlan without dumping the entire repo.
 */
export function formatContextPlanSummary(plan: ContextPlan): string {
  const lines: string[] = [
    `Workspace: ${plan.workspaceRootName}`,
    `Estimated context budget: ${plan.budget.usedTokens} / ${plan.budget.budgetTokens} token-equivalents (${plan.budget.remainingTokens} remaining; ${plan.budget.estimationMethod})`,
  ];

  if (plan.unknownReferences.length > 0) {
    lines.push("Unresolved references:");
    for (const unk of plan.unknownReferences) {
      lines.push(`  - [${unk.kind}] ${unk.reference}: ${unk.reason}`);
    }
  }

  if (plan.selectedFiles.length > 0) {
    lines.push(`Selected files (${plan.selectedFiles.length}):`);
    for (const f of plan.selectedFiles) {
      lines.push(`  - ${f.relativePath} [${f.source}, ~${f.estimatedTokens} est. tokens]: ${f.reason}`);
    }
  }

  if (plan.budget.excludedOrTruncated.length > 0) {
    lines.push(`Excluded/truncated (${plan.budget.excludedOrTruncated.length}):`);
    for (const ex of plan.budget.excludedOrTruncated.slice(0, 6)) {
      lines.push(`  - ${ex.relativePath}: ${ex.reason}`);
    }
  }

  return lines.join("\n");
}
