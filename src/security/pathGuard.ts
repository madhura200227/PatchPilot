import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isSensitiveFilePath } from "./secretFilter";

/**
 * PatchPilot Workspace Filesystem Security Guard
 *
 * Addresses all Prompt 005 security audit findings:
 * - Rejects ../ traversal, absolute external paths, Windows drive paths, UNC paths, and null bytes.
 * - Eliminates blanket dotfile bypasses via an explicit ALLOWED_DOTFILES policy.
 * - Protects .git, secrets, keys, .env, .ssh, .npmrc, and generated/vendor directories.
 * - Checks every existing path component for symlink / junction / reparse-point escapes.
 * - Detects binary files and enforces strict file-size ceilings.
 * - Mitigates TOCTOU risks by canonicalizing on open and re-verifying realpath against root.
 */

export const ALLOWED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".pyi",
  ".rst",
  ".md",
  ".txt",
  ".json",
  ".toml",
  ".yaml",
  ".yml",
  ".ini",
  ".cfg",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".svg",
  ".xml",
  ".sql",
  ".graphql",
  ".gql",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".go",
  ".rs",
  ".java",
  ".rb",
  ".php",
  ".vue",
  ".svelte",
]);

export const ALLOWED_EXTENSIONLESS_FILES = new Set([
  "makefile",
  "dockerfile",
  "readme",
  "license",
  "licence",
  "procfile",
  "justfile",
  "pipfile",
  "changelog",
  "contributing",
  "authors",
  "notice",
  "manifest",
]);

export const ALLOWED_DOTFILES = new Set([
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
  ".flake8",
  ".prettierrc",
  ".prettierrc.json",
  ".eslintrc",
  ".eslintrc.json",
  ".eslintrc.js",
  ".pylintrc",
  ".pre-commit-config.yaml",
  ".python-version",
  ".nvmrc",
  ".vscodeignore",
  ".dockerignore",
  ".patchpilot-fixture",
  ".env.example",
  ".env.sample",
  ".env.template",
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
  ".zsh",
  ".ps1",
  ".psm1",
  ".vbs",
  ".msi",
  ".com",
  ".scr",
  ".jar",
  ".bin",
  ".wasm",
  ".env",
  ".pfx",
  ".pem",
  ".key",
  ".p12",
  ".der",
  ".crt",
  ".cer",
  ".pyc",
  ".pyo",
]);

export const PROTECTED_DIRECTORIES = new Set([
  ".git",
  ".ssh",
  ".aws",
  ".kube",
  ".gnupg",
  ".patchpilot",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".vscode-test",
]);

export const MAX_FILE_SIZE_BYTES = 1024 * 1024; // 1 MiB

export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecurityError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface ResolvePathOptions {
  checkExtension?: boolean;
  mustExist?: boolean;
  allowDirectory?: boolean;
  rejectSymlinks?: boolean;
  allowAbsoluteInsideRoot?: boolean;
}

export interface SafeReadResult {
  resolvedPath: string;
  relativePath: string;
  content: string;
  sha256: string;
  size: number;
}

function normalizeForComparison(p: string): string {
  const normalized = path.normalize(p);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isWithinRoot(candidatePath: string, rootPath: string): boolean {
  const normCandidate = normalizeForComparison(candidatePath);
  const normRoot = normalizeForComparison(rootPath);
  if (normCandidate === normRoot) {
    return true;
  }
  const sep = path.sep.toLowerCase();
  const prefix = normRoot.endsWith(sep) ? normRoot : normRoot + sep;
  return normCandidate.startsWith(prefix);
}

/**
 * Checks whether a buffer appears to contain binary (non-UTF8 text) data.
 */
export function isBinaryBuffer(buf: Buffer): boolean {
  const sampleLength = Math.min(buf.length, 8192);
  if (sampleLength === 0) {
    return false;
  }

  let suspiciousCount = 0;
  for (let i = 0; i < sampleLength; i++) {
    const byte = buf[i];
    if (byte === 0) {
      return true;
    }
    // Control chars other than tab (9), LF (10), VT (11), FF (12), CR (13)
    if (byte < 9 || (byte > 13 && byte < 32)) {
      suspiciousCount++;
    }
  }

  return suspiciousCount / sampleLength > 0.3;
}

/**
 * Validates that a workspace root exists and returns its canonical realpath.
 */
export function resolveCanonicalWorkspaceRoot(workspaceRoot: string): string {
  if (!workspaceRoot || typeof workspaceRoot !== "string") {
    throw new SecurityError("Workspace root must be a non-empty path.");
  }
  const resolved = path.resolve(workspaceRoot);
  if (!fs.existsSync(resolved)) {
    throw new SecurityError(`Workspace root does not exist: "${resolved}"`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new SecurityError(`Workspace root must be a directory: "${resolved}"`);
  }
  return fs.realpathSync(resolved);
}

/**
 * Resolves and validates a target path strictly inside workspaceRoot.
 */
export function resolveSafeWorkspacePath(
  workspaceRoot: string,
  targetPath: string,
  options: ResolvePathOptions = {}
): string {
  if (!targetPath || typeof targetPath !== "string") {
    throw new SecurityError("Path must be a non-empty string.");
  }

  const trimmed = targetPath.trim();
  if (!trimmed) {
    throw new SecurityError("Path must be a non-empty string.");
  }

  // 1. Reject null bytes and control characters
  if (/[\0\r\n]/.test(trimmed)) {
    throw new SecurityError("Path contains prohibited control or null byte sequence.");
  }

  // 2. Reject UNC paths (\\server\share or //server/share)
  if (trimmed.startsWith("\\\\") || trimmed.startsWith("//")) {
    throw new SecurityError(`UNC network paths are prohibited: "${targetPath}"`);
  }

  const rootReal = resolveCanonicalWorkspaceRoot(workspaceRoot);

  // 3. Reject Windows drive letters and absolute paths unless explicitly permitted inside root
  const hasWindowsDrive = /^[a-zA-Z]:/.test(trimmed);
  const isAbs = path.isAbsolute(trimmed) || hasWindowsDrive;
  let combined: string;

  if (isAbs) {
    if (!options.allowAbsoluteInsideRoot) {
      throw new SecurityError(
        `Access Denied: Absolute or drive-qualified path "${targetPath}" is not permitted; use workspace-relative paths.`
      );
    }
    combined = path.resolve(trimmed);
  } else {
    combined = path.resolve(rootReal, trimmed);
  }

  // 4. Lexical containment check
  if (!isWithinRoot(combined, rootReal)) {
    throw new SecurityError(
      `Access Denied: Path "${targetPath}" traverses outside configured workspace boundary.`
    );
  }

  // 5. Inspect relative path segments for protected directories & secret files
  const relPosix = path.relative(rootReal, combined).replace(/\\/g, "/");
  if (relPosix.startsWith("..") || path.isAbsolute(relPosix)) {
    throw new SecurityError(
      `Access Denied: Path "${targetPath}" escapes configured workspace boundary.`
    );
  }

  const segments = relPosix.split("/").filter((s) => s.length > 0 && s !== ".");
  for (const segment of segments) {
    if (PROTECTED_DIRECTORIES.has(segment.toLowerCase())) {
      throw new SecurityError(
        `Access Denied: Protected directory "${segment}" cannot be accessed by workspace tools.`
      );
    }
  }

  if (relPosix && relPosix !== "." && isSensitiveFilePath(relPosix)) {
    throw new SecurityError(
      `Access Denied: Sensitive or secret-bearing path "${relPosix}" is blocked.`
    );
  }

  // 6. Walk every existing component from rootReal down to detect symlinks / reparse-point escapes
  let currentPath = rootReal;
  for (const segment of segments) {
    currentPath = path.join(currentPath, segment);
    if (!fs.existsSync(currentPath)) {
      break;
    }

    const lstat = fs.lstatSync(currentPath);
    if (lstat.isSymbolicLink()) {
      if (options.rejectSymlinks) {
        throw new SecurityError(
          `Symlink Denied: Path "${targetPath}" traverses symbolic link or reparse point "${segment}".`
        );
      }
      const realTarget = fs.realpathSync(currentPath);
      if (!isWithinRoot(realTarget, rootReal)) {
        throw new SecurityError(
          `Symlink Escape Denied: Path "${targetPath}" resolves outside workspace root.`
        );
      }
    }
  }

  // Final realpath check if target itself exists
  if (fs.existsSync(combined)) {
    const realCombined = fs.realpathSync(combined);
    if (!isWithinRoot(realCombined, rootReal)) {
      throw new SecurityError(
        `Symlink Escape Denied: Path "${targetPath}" resolves outside workspace root.`
      );
    }
    const stat = fs.statSync(realCombined);
    if (!options.allowDirectory && options.checkExtension !== false && stat.isDirectory()) {
      throw new SecurityError(`Path refers to a directory where a file was expected: "${targetPath}"`);
    }
  } else if (options.mustExist) {
    throw new SecurityError(`File not found: "${targetPath}"`);
  } else {
    // Verify nearest existing parent resolves inside rootReal
    let parent = path.dirname(combined);
    while (parent && parent !== path.dirname(parent)) {
      if (fs.existsSync(parent)) {
        const realParent = fs.realpathSync(parent);
        if (!isWithinRoot(realParent, rootReal)) {
          throw new SecurityError(
            `Symlink Escape Denied: Parent directory of "${targetPath}" resolves outside workspace root.`
          );
        }
        break;
      }
      parent = path.dirname(parent);
    }
  }

  // 7. Strict filename, dotfile, and extension policy (NO blanket dotfile bypass)
  if (options.checkExtension !== false && relPosix && relPosix !== ".") {
    const filename = path.basename(combined);
    const lowerFilename = filename.toLowerCase();

    if (filename.startsWith(".")) {
      if (!ALLOWED_DOTFILES.has(lowerFilename)) {
        throw new SecurityError(
          `Disallowed Dotfile: "${filename}" is not in the approved workspace dotfile policy.`
        );
      }
    } else {
      const ext = path.extname(filename).toLowerCase();
      if (ext === "") {
        if (!ALLOWED_EXTENSIONLESS_FILES.has(lowerFilename)) {
          throw new SecurityError(
            `Unapproved File: Extensionless file "${filename}" is not in the approved workspace file list.`
          );
        }
      } else {
        if (DISALLOWED_EXTENSIONS.has(ext)) {
          throw new SecurityError(
            `Disallowed File Extension: Files with extension "${ext}" are blocked for security.`
          );
        }
        if (!ALLOWED_EXTENSIONS.has(ext)) {
          throw new SecurityError(
            `Unapproved File Extension: Extension "${ext}" is not in the approved workspace file list.`
          );
        }
      }
    }
  }

  return combined;
}

/**
 * Safely reads a UTF-8 text file inside workspaceRoot with binary, size, and post-open canonical checks.
 */
export async function safeReadWorkspaceTextFile(
  workspaceRoot: string,
  relativeFilePath: string
): Promise<SafeReadResult> {
  const rootReal = resolveCanonicalWorkspaceRoot(workspaceRoot);
  const safePath = resolveSafeWorkspacePath(rootReal, relativeFilePath, {
    checkExtension: true,
    mustExist: true,
    allowDirectory: false,
  });

  // Use O_NOFOLLOW on POSIX platforms where supported to narrow TOCTOU window
  const openFlags =
    process.platform !== "win32" && typeof fs.constants.O_NOFOLLOW === "number"
      ? fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
      : fs.constants.O_RDONLY;

  const handle = await fs.promises.open(safePath, openFlags);
  try {
    // Re-verify canonical location immediately after opening handle
    const postOpenReal = await fs.promises.realpath(safePath);
    if (!isWithinRoot(postOpenReal, rootReal)) {
      throw new SecurityError(
        `TOCTOU Containment Violation: "${relativeFilePath}" resolved outside workspace root during read.`
      );
    }

    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new SecurityError(`Cannot read non-regular file: "${relativeFilePath}"`);
    }
    if (stat.size > MAX_FILE_SIZE_BYTES) {
      throw new SecurityError(
        `File size ${stat.size} bytes exceeds maximum allowed limit of ${MAX_FILE_SIZE_BYTES} bytes.`
      );
    }

    const buf = await handle.readFile();
    if (buf.length > MAX_FILE_SIZE_BYTES) {
      throw new SecurityError(
        `Read content (${buf.length} bytes) exceeds maximum allowed limit of ${MAX_FILE_SIZE_BYTES} bytes.`
      );
    }
    if (isBinaryBuffer(buf)) {
      throw new SecurityError(
        `Binary File Rejected: "${relativeFilePath}" appears to be binary and cannot be read as source text.`
      );
    }

    const content = buf.toString("utf8");
    const sha256 = crypto.createHash("sha256").update(content, "utf8").digest("hex");
    const relativePath = path.relative(rootReal, postOpenReal).replace(/\\/g, "/");

    return {
      resolvedPath: postOpenReal,
      relativePath,
      content,
      sha256,
      size: buf.length,
    };
  } finally {
    await handle.close();
  }
}
