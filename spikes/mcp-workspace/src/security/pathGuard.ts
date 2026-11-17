import * as path from "node:path";
import * as fs from "node:fs";

export const ALLOWED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".txt",
  ".yml",
  ".yaml",
  "", // for extensionless files like .patchpilot-fixture or README
]);

export const DISALLOWED_EXTENSIONS = new Set([
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bat",
  ".cmd",
  ".sh",
  ".bash",
  ".ps1",
  ".vbs",
  ".bin",
  ".env",
  ".pfx",
  ".pem",
  ".key",
]);

export const MAX_FILE_SIZE_BYTES = 1024 * 1024; // 1MB

export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecurityError";
  }
}

/**
 * Resolves and strictly validates that a relative or absolute path is contained
 * entirely within the configured workspaceRoot.
 *
 * Enforces:
 * - Rejection of null bytes
 * - Rejection of directory traversal (../)
 * - Rejection of drive letter jumping on Windows
 * - Rejection of symlinks resolving outside the root
 * - Rejection of unapproved file extensions
 */
export function resolveSafeWorkspacePath(
  workspaceRoot: string,
  targetRelativePath: string,
  options: { checkExtension?: boolean; mustExist?: boolean } = {}
): string {
  if (!targetRelativePath || typeof targetRelativePath !== "string") {
    throw new SecurityError("Path must be a non-empty string");
  }

  // 1. Reject null bytes (poison null byte attack)
  if (targetRelativePath.includes("\0")) {
    throw new SecurityError("Path contains prohibited null byte sequence");
  }

  const rootResolved = path.resolve(workspaceRoot);

  // 2. Normalize and resolve the target path relative to workspaceRoot
  // If target starts with Windows drive letter (e.g. C: or E:) or absolute slash,
  // we treat it as an attempt to access absolute filesystem paths.
  let combined: string;
  if (path.isAbsolute(targetRelativePath)) {
    combined = path.resolve(targetRelativePath);
  } else {
    // Check if someone passed a drive letter on Windows like "C:foo"
    if (/^[a-zA-Z]:/.test(targetRelativePath)) {
      combined = path.resolve(targetRelativePath);
    } else {
      combined = path.resolve(rootResolved, targetRelativePath);
    }
  }

  // Normalize case on Windows for containment check
  const normalizedRoot = path.normalize(rootResolved).toLowerCase();
  const normalizedCombined = path.normalize(combined).toLowerCase();

  // Root must be a prefix of target, followed by separator or exact match
  const isContained =
    normalizedCombined === normalizedRoot ||
    normalizedCombined.startsWith(normalizedRoot.endsWith(path.sep.toLowerCase()) ? normalizedRoot : normalizedRoot + path.sep.toLowerCase());

  if (!isContained) {
    throw new SecurityError(
      `Access Denied: Path "${targetRelativePath}" traverses outside configured workspace boundary "${rootResolved}"`
    );
  }

  // 3. Symlink escape check: If file or an ancestor directory exists, resolve realpath
  if (fs.existsSync(combined)) {
    const real = fs.realpathSync(combined);
    const normalizedReal = path.normalize(real).toLowerCase();
    const isRealContained =
      normalizedReal === normalizedRoot ||
      normalizedReal.startsWith(normalizedRoot.endsWith(path.sep.toLowerCase()) ? normalizedRoot : normalizedRoot + path.sep.toLowerCase());

    if (!isRealContained) {
      throw new SecurityError(
        `Symlink Escape Denied: Path "${targetRelativePath}" points to real location "${real}" outside workspace root`
      );
    }
  } else if (options.mustExist) {
    throw new SecurityError(`File not found: "${targetRelativePath}"`);
  } else {
    // For non-existent files to be written, check realpath of existing parent directory
    let parent = path.dirname(combined);
    while (parent && parent !== path.dirname(parent)) {
      if (fs.existsSync(parent)) {
        const realParent = fs.realpathSync(parent);
        const normalizedRealParent = path.normalize(realParent).toLowerCase();
        const isParentContained =
          normalizedRealParent === normalizedRoot ||
          normalizedRealParent.startsWith(normalizedRoot.endsWith(path.sep.toLowerCase()) ? normalizedRoot : normalizedRoot + path.sep.toLowerCase());

        if (!isParentContained) {
          throw new SecurityError(
            `Symlink Escape Denied: Parent directory of "${targetRelativePath}" resolves outside workspace root`
          );
        }
        break;
      }
      parent = path.dirname(parent);
    }
  }

  // 4. File extension check
  if (options.checkExtension !== false) {
    const filename = path.basename(combined);
    // Ignore dotfiles like .patchpilot-fixture, .gitignore, etc.
    if (!filename.startsWith(".")) {
      const ext = path.extname(combined).toLowerCase();
      if (DISALLOWED_EXTENSIONS.has(ext)) {
        throw new SecurityError(`Disallowed File Extension: Files with extension "${ext}" are blocked for security`);
      }
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        throw new SecurityError(
          `Unapproved File Extension: Extension "${ext}" is not in the approved workspace file list`
        );
      }
    } else {
      // Check for hidden executable files like .env or .bashrc
      const lower = filename.toLowerCase();
      if (lower === ".env" || lower.endsWith(".key") || lower.endsWith(".pem")) {
        throw new SecurityError(`Security Violation: Sensitive configuration file "${filename}" is blocked`);
      }
    }
  }

  return combined;
}
