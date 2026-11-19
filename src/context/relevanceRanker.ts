import * as fs from "node:fs";
import * as path from "node:path";
import { isBinaryBuffer, resolveCanonicalWorkspaceRoot } from "../security/pathGuard";
import { enumerateEligibleFiles } from "./symbolResolver";

/**
 * PatchPilot Deterministic Lexical Relevance Ranker (BM25 + Path/Symbol Boost)
 *
 * Zero external service / vector DB dependency. Ranks workspace files and extracts
 * bounded, non-overlapping code snippets with explicit rationale.
 */

export interface RankedSnippet {
  startLine: number;
  endLine: number;
  content: string;
  matchedTerms: string[];
}

export interface RankedFileResult {
  relativePath: string;
  score: number;
  matchedTerms: string[];
  reason: string;
  snippets: RankedSnippet[];
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "of",
  "to",
  "in",
  "for",
  "on",
  "at",
  "by",
  "with",
  "as",
  "is",
  "it",
  "be",
  "are",
  "was",
  "were",
  "this",
  "that",
  "from",
  "into",
  "must",
  "should",
  "will",
  "can",
  "all",
  "any",
  "add",
  "new",
  "use",
  "make",
  "also",
  "not",
  "its",
  "their",
  "other",
  "existing",
  "well",
]);

/**
 * Extracts normalized search terms from natural language or code identifiers.
 */
export function tokenizeQuery(text: string): string[] {
  if (!text) {
    return [];
  }

  // Split camelCase and extract identifier tokens
  const expanded = text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9_./-]+/g, " ");

  const rawTokens = expanded
    .split(/[\s./\\-]+/)
    .flatMap((tok) => (tok.includes("_") ? [tok, ...tok.split("_")] : [tok]))
    .map((t) => t.toLowerCase().trim())
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));

  return Array.from(new Set(rawTokens));
}

function countTermOccurrences(lowerText: string, term: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = lowerText.indexOf(term, pos)) !== -1) {
    count++;
    pos += term.length;
  }
  return count;
}

function extractMatchingSnippets(
  content: string,
  terms: string[],
  maxSnippets: number = 3,
  contextRadius: number = 4
): RankedSnippet[] {
  const lines = content.split(/\r?\n/);
  const scoredLines: Array<{ lineIdx: number; score: number; matched: string[] }> = [];

  for (let i = 0; i < lines.length; i++) {
    const lowerLine = lines[i].toLowerCase();
    const matched: string[] = [];
    let score = 0;

    for (const term of terms) {
      if (lowerLine.includes(term)) {
        matched.push(term);
        // Boost symbol definitions and CLI decorators
        const isDef = /^\s*(?:def|async def|class|export|function|interface|@.*command)\b/i.test(lines[i]);
        score += isDef ? 2.5 : 1.0;
      }
    }

    if (matched.length > 0) {
      scoredLines.push({ lineIdx: i, score: score + matched.length * 0.5, matched });
    }
  }

  scoredLines.sort((a, b) => b.score - a.score || a.lineIdx - b.lineIdx);

  const ranges: Array<{ start: number; end: number; matched: Set<string> }> = [];
  for (const item of scoredLines) {
    if (ranges.length >= maxSnippets) {
      break;
    }
    const start = Math.max(0, item.lineIdx - contextRadius);
    const end = Math.min(lines.length - 1, item.lineIdx + contextRadius);

    // Merge if overlapping with an existing snippet window
    const overlapping = ranges.find((r) => start <= r.end + 1 && end >= r.start - 1);
    if (overlapping) {
      overlapping.start = Math.min(overlapping.start, start);
      overlapping.end = Math.max(overlapping.end, end);
      for (const m of item.matched) {
        overlapping.matched.add(m);
      }
    } else {
      ranges.push({ start, end, matched: new Set(item.matched) });
    }
  }

  ranges.sort((a, b) => a.start - b.start);

  return ranges.map((r) => {
    const snippetText = lines
      .slice(r.start, r.end + 1)
      .map((l, offset) => `${r.start + offset + 1}: ${l}`)
      .join("\n");
    return {
      startLine: r.start + 1,
      endLine: r.end + 1,
      content: snippetText,
      matchedTerms: Array.from(r.matched),
    };
  });
}

/**
 * Searches and ranks workspace files using BM25 + path/filename relevance boosts.
 */
export function searchAndRankWorkspace(
  workspaceRoot: string,
  query: string,
  options: {
    maxResults?: number;
    maxSnippetsPerFile?: number;
    pathPrefix?: string;
    literalSubstring?: boolean;
  } = {}
): RankedFileResult[] {
  const rootReal = resolveCanonicalWorkspaceRoot(workspaceRoot);
  const maxResults = Math.min(Math.max(options.maxResults ?? 12, 1), 40);
  const maxSnippetsPerFile = Math.min(Math.max(options.maxSnippetsPerFile ?? 3, 1), 8);

  const terms = options.literalSubstring
    ? [query.trim().toLowerCase()].filter((t) => t.length > 0)
    : tokenizeQuery(query);

  if (terms.length === 0) {
    return [];
  }

  let eligibleFiles = enumerateEligibleFiles(rootReal);
  if (options.pathPrefix) {
    const normPrefix = options.pathPrefix.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase();
    eligibleFiles = eligibleFiles.filter(
      (f) => f.toLowerCase() === normPrefix || f.toLowerCase().startsWith(`${normPrefix}/`)
    );
  }

  interface DocEntry {
    relativePath: string;
    content: string;
    lowerContent: string;
    lengthTokens: number;
    termFreqs: Map<string, number>;
    pathMatches: string[];
  }

  const docs: DocEntry[] = [];
  const docFreq = new Map<string, number>();
  let totalDocLength = 0;

  for (const rel of eligibleFiles) {
    const fullPath = path.join(rootReal, rel);
    let buf: Buffer;
    try {
      buf = fs.readFileSync(fullPath);
    } catch {
      continue;
    }
    if (isBinaryBuffer(buf)) {
      continue;
    }

    const content = buf.toString("utf8");
    const lowerContent = content.toLowerCase();
    const lowerPath = rel.toLowerCase();

    const termFreqs = new Map<string, number>();
    const pathMatches: string[] = [];

    for (const term of terms) {
      const tf = countTermOccurrences(lowerContent, term);
      if (tf > 0) {
        termFreqs.set(term, tf);
        docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
      }
      if (lowerPath.includes(term)) {
        pathMatches.push(term);
      }
    }

    const lengthTokens = Math.max(1, Math.ceil(content.length / 5));
    totalDocLength += lengthTokens;

    if (termFreqs.size > 0 || pathMatches.length > 0) {
      docs.push({
        relativePath: rel,
        content,
        lowerContent,
        lengthTokens,
        termFreqs,
        pathMatches,
      });
    }
  }

  if (docs.length === 0) {
    return [];
  }

  const N = Math.max(eligibleFiles.length, docs.length);
  const avgdl = Math.max(1, totalDocLength / N);
  const k1 = 1.5;
  const b = 0.75;

  const ranked: RankedFileResult[] = [];

  for (const doc of docs) {
    let bm25 = 0;
    const matchedTerms = new Set<string>(doc.pathMatches);

    for (const [term, tf] of doc.termFreqs.entries()) {
      matchedTerms.add(term);
      const df = docFreq.get(term) ?? 1;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      const denom = tf + k1 * (1 - b + b * (doc.lengthTokens / avgdl));
      bm25 += idf * ((tf * (k1 + 1)) / denom);
    }

    // Path & multi-term coverage boosts
    const pathBoost = doc.pathMatches.length * 2.5;
    const coverageBoost = (matchedTerms.size / terms.length) * 3.0;
    const totalScore = Number((bm25 + pathBoost + coverageBoost).toFixed(2));

    const snippets = extractMatchingSnippets(
      doc.content,
      Array.from(matchedTerms),
      maxSnippetsPerFile
    );

    const reasonParts: string[] = [
      `BM25+path score=${totalScore}`,
      `matched [${Array.from(matchedTerms).slice(0, 6).join(", ")}]`,
    ];
    if (doc.pathMatches.length > 0) {
      reasonParts.push(`path match (${doc.pathMatches.join(", ")})`);
    }

    ranked.push({
      relativePath: doc.relativePath,
      score: totalScore,
      matchedTerms: Array.from(matchedTerms),
      reason: reasonParts.join("; "),
      snippets,
    });
  }

  ranked.sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath));
  return ranked.slice(0, maxResults);
}
