import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveSafeWorkspacePath, MAX_FILE_SIZE_BYTES } from "../security/pathGuard.js";

const execFileAsync = promisify(execFile);

export function computeSha256(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export interface WorkspaceFileInfo {
  name: string;
  relativePath: string;
  isDirectory: boolean;
  size: number;
}

export interface ReadFileResult {
  path: string;
  content: string;
  sha256: string;
  size: number;
}

export interface WriteFileResult {
  success: boolean;
  path: string;
  sha256: string;
  bytesWritten: number;
}

export interface RunTestsResult {
  exitCode: number;
  passed: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface WorkspaceStatusResult {
  clean: boolean;
  branch: string;
  statusText: string;
  modifiedFiles: string[];
  untrackedFiles: string[];
}

/**
 * Tool A: list_workspace_files
 */
export async function listWorkspaceFiles(
  workspaceRoot: string,
  relativeDir: string = "."
): Promise<WorkspaceFileInfo[]> {
  const safeDir = resolveSafeWorkspacePath(workspaceRoot, relativeDir, {
    checkExtension: false,
    mustExist: true,
  });

  const stat = await fs.promises.stat(safeDir);
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: "${relativeDir}"`);
  }

  const entries = await fs.promises.readdir(safeDir, { withFileTypes: true });
  const results: WorkspaceFileInfo[] = [];

  for (const entry of entries) {
    if (entry.name === ".git") continue; // Never expose internal git objects
    const fullPath = path.join(safeDir, entry.name);
    const rel = path.relative(workspaceRoot, fullPath).replace(/\\/g, "/");

    let size = 0;
    try {
      const s = await fs.promises.stat(fullPath);
      size = s.size;
    } catch {
      // Ignore unreadable entries
    }

    results.push({
      name: entry.name,
      relativePath: rel,
      isDirectory: entry.isDirectory(),
      size,
    });
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Tool B: read_workspace_file
 */
export async function readWorkspaceFile(
  workspaceRoot: string,
  relativeFilePath: string
): Promise<ReadFileResult> {
  const safeFile = resolveSafeWorkspacePath(workspaceRoot, relativeFilePath, {
    checkExtension: true,
    mustExist: true,
  });

  const stat = await fs.promises.stat(safeFile);
  if (stat.isDirectory()) {
    throw new Error(`Cannot read directory as file: "${relativeFilePath}"`);
  }

  if (stat.size > MAX_FILE_SIZE_BYTES) {
    throw new Error(`File size ${stat.size} bytes exceeds maximum allowed limit of ${MAX_FILE_SIZE_BYTES} bytes`);
  }

  const content = await fs.promises.readFile(safeFile, "utf8");
  const sha256 = computeSha256(content);
  const normalizedRel = path.relative(workspaceRoot, safeFile).replace(/\\/g, "/");

  return {
    path: normalizedRel,
    content,
    sha256,
    size: stat.size,
  };
}

/**
 * Tool C: write_workspace_file
 */
export async function writeWorkspaceFile(
  workspaceRoot: string,
  relativeFilePath: string,
  content: string
): Promise<WriteFileResult> {
  if (typeof content !== "string") {
    throw new Error("File content must be a string");
  }

  const byteLength = Buffer.byteLength(content, "utf8");
  if (byteLength > MAX_FILE_SIZE_BYTES) {
    throw new Error(
      `Content size ${byteLength} bytes exceeds maximum allowed limit of ${MAX_FILE_SIZE_BYTES} bytes`
    );
  }

  const safeFile = resolveSafeWorkspacePath(workspaceRoot, relativeFilePath, {
    checkExtension: true,
    mustExist: false,
  });

  // Ensure parent directory exists within safe bounds
  const parentDir = path.dirname(safeFile);
  await fs.promises.mkdir(parentDir, { recursive: true });

  await fs.promises.writeFile(safeFile, content, "utf8");
  const sha256 = computeSha256(content);
  const normalizedRel = path.relative(workspaceRoot, safeFile).replace(/\\/g, "/");

  return {
    success: true,
    path: normalizedRel,
    sha256,
    bytesWritten: byteLength,
  };
}

/**
 * Tool D: run_workspace_tests
 * Strictly runs pre-approved deterministic test command.
 * Arbitrary shell execution is completely prevented (shell: false).
 */
export async function runWorkspaceTests(
  workspaceRoot: string,
  testFile?: string,
  timeoutMs: number = 5000
): Promise<RunTestsResult> {
  // Use approved test target
  const target = testFile || "tests/calculator.test.mjs";
  const safeTestFile = resolveSafeWorkspacePath(workspaceRoot, target, {
    checkExtension: true,
    mustExist: true,
  });

  const cleanEnv = { ...process.env };
  delete (cleanEnv as Record<string, string | undefined>)["NODE_TEST_CONTEXT"];

  const startTime = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync("node", ["--test", safeTestFile], {
      cwd: workspaceRoot,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024, // 64KB output limit
      windowsHide: true,
      shell: false, // Critical: prevent shell execution & command injection
      env: cleanEnv,
    });

    const durationMs = Date.now() - startTime;
    return {
      exitCode: 0,
      passed: true,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      durationMs,
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - startTime;
    const execErr = err as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };

    return {
      exitCode: typeof execErr.code === "number" ? execErr.code : 1,
      passed: false,
      stdout: (execErr.stdout || "").trim(),
      stderr: (execErr.stderr || (err instanceof Error ? err.message : String(err))).trim(),
      durationMs,
    };
  }
}

/**
 * Tool E: get_workspace_status
 * Returns git status and modified/untracked files within fixture workspace.
 */
export async function getWorkspaceStatus(workspaceRoot: string): Promise<WorkspaceStatusResult> {
  const safeRoot = resolveSafeWorkspacePath(workspaceRoot, ".", {
    checkExtension: false,
    mustExist: true,
  });

  let branch = "unknown";
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: safeRoot,
      timeout: 3000,
      windowsHide: true,
      shell: false,
    });
    branch = stdout.trim();
  } catch {
    branch = "detached";
  }

  let statusOutput = "";
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: safeRoot,
      timeout: 3000,
      windowsHide: true,
      shell: false,
    });
    statusOutput = stdout.trim();
  } catch (err: unknown) {
    throw new Error(`Failed to query workspace git status: ${err instanceof Error ? err.message : String(err)}`);
  }

  const modifiedFiles: string[] = [];
  const untrackedFiles: string[] = [];

  if (statusOutput) {
    const lines = statusOutput.split(/\r?\n/);
    for (const line of lines) {
      if (!line) continue;
      const code = line.slice(0, 2);
      const filePath = line.slice(3).trim();
      if (code === "??") {
        untrackedFiles.push(filePath);
      } else {
        modifiedFiles.push(filePath);
      }
    }
  }

  return {
    clean: statusOutput.length === 0,
    branch,
    statusText: statusOutput || "CLEAN",
    modifiedFiles,
    untrackedFiles,
  };
}
