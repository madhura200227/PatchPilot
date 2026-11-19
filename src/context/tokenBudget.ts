/**
 * PatchPilot Context Token Budget Estimator & Tracker
 *
 * Explicitly treats token counts as heuristic estimates (~4 UTF-8 bytes per token-equivalent)
 * rather than exact model-specific tokenizer counts.
 */

export const DEFAULT_CONTEXT_TOKEN_BUDGET = 16_000;
export const CONTEXT_TOKEN_ESTIMATION_METHOD =
  "Heuristic estimate (~4 UTF-8 bytes per token-equivalent; approximate, not an exact model tokenizer count)";

export type BudgetCategory =
  | "userRequest"
  | "explicitFiles"
  | "explicitSymbols"
  | "workspaceStructure"
  | "retrievedSnippets";

export interface BudgetExclusion {
  relativePath: string;
  reason: string;
  originalEstimatedTokens: number;
  keptEstimatedTokens: number;
}

export interface ContextBudgetSnapshot {
  budgetTokens: number;
  usedTokens: number;
  remainingTokens: number;
  estimationMethod: string;
  byCategory: Record<BudgetCategory, number>;
  excludedOrTruncated: BudgetExclusion[];
}

export function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

export function truncateTextToTokenBudget(
  text: string,
  maxTokens: number
): { text: string; truncated: boolean; originalTokens: number; keptTokens: number } {
  const originalTokens = estimateTokens(text);
  if (maxTokens <= 0) {
    return { text: "", truncated: originalTokens > 0, originalTokens, keptTokens: 0 };
  }
  if (originalTokens <= maxTokens) {
    return { text, truncated: false, originalTokens, keptTokens: originalTokens };
  }

  const maxChars = Math.max(32, maxTokens * 4 - 48);
  const lines = text.split(/\r?\n/);
  const keptLines: string[] = [];
  let charCount = 0;

  for (const line of lines) {
    if (charCount + line.length + 1 > maxChars && keptLines.length > 0) {
      break;
    }
    keptLines.push(line);
    charCount += line.length + 1;
  }

  const truncatedText = `${keptLines.join("\n")}\n... [truncated to fit context budget]`;
  return {
    text: truncatedText,
    truncated: true,
    originalTokens,
    keptTokens: estimateTokens(truncatedText),
  };
}

export class ContextBudgetTracker {
  private readonly budgetTokens: number;
  private usedTokens = 0;
  private readonly byCategory: Record<BudgetCategory, number> = {
    userRequest: 0,
    explicitFiles: 0,
    explicitSymbols: 0,
    workspaceStructure: 0,
    retrievedSnippets: 0,
  };
  private readonly excludedOrTruncated: BudgetExclusion[] = [];

  constructor(budgetTokens: number = DEFAULT_CONTEXT_TOKEN_BUDGET) {
    this.budgetTokens = budgetTokens > 0 ? Math.floor(budgetTokens) : DEFAULT_CONTEXT_TOKEN_BUDGET;
  }

  public getRemainingTokens(): number {
    return Math.max(0, this.budgetTokens - this.usedTokens);
  }

  public getUsedTokens(): number {
    return this.usedTokens;
  }

  public getBudgetTokens(): number {
    return this.budgetTokens;
  }

  public allocate(category: BudgetCategory, tokens: number): boolean {
    if (tokens <= 0) {
      return true;
    }
    if (tokens > this.getRemainingTokens()) {
      return false;
    }
    this.usedTokens += tokens;
    this.byCategory[category] += tokens;
    return true;
  }

  public forceRecord(category: BudgetCategory, tokens: number): void {
    if (tokens <= 0) {
      return;
    }
    this.usedTokens += tokens;
    this.byCategory[category] += tokens;
  }

  public recordExclusion(exclusion: BudgetExclusion): void {
    this.excludedOrTruncated.push(exclusion);
  }

  public getSnapshot(): ContextBudgetSnapshot {
    return {
      budgetTokens: this.budgetTokens,
      usedTokens: this.usedTokens,
      remainingTokens: this.getRemainingTokens(),
      estimationMethod: CONTEXT_TOKEN_ESTIMATION_METHOD,
      byCategory: { ...this.byCategory },
      excludedOrTruncated: [...this.excludedOrTruncated],
    };
  }
}
