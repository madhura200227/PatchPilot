/**
 * PatchPilot Explicit Mention Parser
 *
 * Parses explicit @file and @symbol references from user prompts while avoiding
 * false positives on email addresses or Python/TS decorators like @app.route.
 */

export interface ParsedMentions {
  fileMentions: string[];
  symbolMentions: string[];
  cleanedPrompt: string;
}

const KNOWN_FILE_EXT_PATTERN =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|py|pyi|rst|md|txt|json|toml|yaml|yml|ini|cfg|html|css|scss|sql|go|rs|java|c|h|cpp|hpp)$/i;

export function parseMentions(prompt: string): ParsedMentions {
  const fileSet = new Set<string>();
  const symbolSet = new Set<string>();

  if (!prompt || typeof prompt !== "string") {
    return { fileMentions: [], symbolMentions: [], cleanedPrompt: "" };
  }

  // 1. Explicit @file:<path> or @file:"<path>" or @file <path>
  const explicitFileRegex =
    /(?:^|[\s([{"'])@file(?::|\s+)(?:"([^"]+)"|'([^']+)'|([^\s,;)\]}'"]+))/gi;
  let match: RegExpExecArray | null;
  while ((match = explicitFileRegex.exec(prompt)) !== null) {
    const raw = (match[1] || match[2] || match[3] || "").trim().replace(/[.,;:!?]+$/, "");
    if (raw) {
      fileSet.add(raw.replace(/\\/g, "/"));
    }
  }

  // 2. Explicit @symbol:<name> or @symbol <name>
  const explicitSymbolRegex =
    /(?:^|[\s([{"'])@symbol(?::|\s+)(?:"([^"]+)"|'([^']+)'|([A-Za-z_][A-Za-z0-9_.:-]*))/gi;
  while ((match = explicitSymbolRegex.exec(prompt)) !== null) {
    const raw = (match[1] || match[2] || match[3] || "").trim();
    if (raw) {
      symbolSet.add(raw);
    }
  }

  // 3. Shorthand @path/to/file.ext (must include a slash or end with a known code/doc extension,
  //    and must not be preceded by an email username char)
  const shorthandFileRegex =
    /(?:^|[\s([{"'])@([A-Za-z0-9_.\-/\\]+(?:\.[A-Za-z0-9]+)?)/g;
  while ((match = shorthandFileRegex.exec(prompt)) !== null) {
    const candidate = match[1].trim().replace(/[.,;:!?]+$/, "");
    const lower = candidate.toLowerCase();
    if (lower === "file" || lower === "symbol") {
      continue;
    }
    const hasSlash = candidate.includes("/") || candidate.includes("\\");
    const hasKnownExt = KNOWN_FILE_EXT_PATTERN.test(candidate);
    if (hasSlash || hasKnownExt) {
      fileSet.add(candidate.replace(/\\/g, "/"));
    }
  }

  return {
    fileMentions: Array.from(fileSet),
    symbolMentions: Array.from(symbolSet),
    cleanedPrompt: prompt.trim(),
  };
}
