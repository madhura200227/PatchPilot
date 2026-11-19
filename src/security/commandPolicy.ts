import { spawn } from "node:child_process";
import * as path from "node:path";
import { resolveSafeWorkspacePath, SecurityError } from "./pathGuard";
import { sanitizeProcessEnv, sanitizeSecretText } from "./secretFilter";

/**
 * PatchPilot Safe Command Execution Policy
 *
 * Strictly enforces:
 * - Fixed executable allowlist (no arbitrary binaries or shell wrappers)
 * - Argument array validation per executable (no shell string interpolation)
 * - shell: false (defense-in-depth, NOT the sole boundary)
 * - Workspace-root working directory enforcement
 * - Output size bounds (64 KiB per stream)
 * - Execution timeout and AbortSignal child-process termination
 * - Sanitized environment variables
 */

export const ALLOWED_EXECUTABLES = new Set([
  "pytest",
  "python",
  "python3",
  "flask",
  "node",
  "npm",
  "git",
]);

export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
export const MAX_COMMAND_TIMEOUT_MS = 120_000;
export const MAX_OUTPUT_BYTES = 64 * 1024;

const SHELL_METACHAR_PATTERN = /[;&|`$<>()\r\n\0]/;
const SAFE_TEST_PATH_PATTERN = /(?:^|\/)(?:tests?|__tests__)\/|(?:\.test|\.spec)\.(?:mjs|cjs|js|ts|tsx)$|(?:^|\/)test_[^/]+\.py$|(?:^|\/)[^/]+_test\.py$/i;
const SAFE_PYTEST_FLAG_PATTERN = /^(?:-q|-v|-vv|-s|-x|--collect-only|--disable-warnings|--no-header|--tb=(?:short|line|no|auto|long)|--maxfail=\d+|--durations=\d+|-r[a-zA-Z]+)$/;
const SAFE_MODULE_SPEC_PATTERN = /^[a-zA-Z0-9_.:-]+$/;

export interface ValidatedCommandSpec {
  executable: string;
  args: string[];
  displayCommand: string;
}

export interface CommandExecutionOptions {
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  extraEnv?: Record<string, string>;
  secretsToRedact?: readonly string[];
}

export interface CommandExecutionResult {
  executable: string;
  args: string[];
  exitCode: number;
  passed: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
}

function assertCleanArg(arg: string, label: string): void {
  if (typeof arg !== "string" || arg.length === 0 || arg.length > 512) {
    throw new SecurityError(`Invalid ${label}: argument must be a non-empty string up to 512 chars.`);
  }
  if (SHELL_METACHAR_PATTERN.test(arg)) {
    throw new SecurityError(`Prohibited shell metacharacters detected in argument "${arg}".`);
  }
}

function assertSafeTestTarget(target: string, workspaceRoot: string, requireExist: boolean): void {
  assertCleanArg(target, "test target");

  // Support pytest node IDs like tests/test_cli.py::test_config_command
  const filePart = target.split("::")[0];
  if (target.includes("::")) {
    const nodeParts = target.split("::").slice(1);
    for (const part of nodeParts) {
      if (!/^[a-zA-Z0-9_\-\[\],. ]+$/.test(part)) {
        throw new SecurityError(`Invalid pytest node selector: "${target}"`);
      }
    }
  }

  // Must resolve safely inside workspace
  const allowDir = !path.extname(filePart);
  resolveSafeWorkspacePath(workspaceRoot, filePart, {
    checkExtension: !allowDir,
    mustExist: requireExist,
    allowDirectory: allowDir,
  });

  const normalized = filePart.replace(/\\/g, "/");
  const isTestDir = normalized === "tests" || normalized === "test" || normalized.startsWith("tests/") || normalized.startsWith("test/");
  if (!isTestDir && !SAFE_TEST_PATH_PATTERN.test(normalized)) {
    throw new SecurityError(
      `Disallowed test target "${target}": only approved test directories (tests/, test/) or test files (test_*.py, *_test.py, *.test.*, *.spec.*) are permitted.`
    );
  }
}

function validatePytestArgs(args: string[], workspaceRoot: string, requireExist: boolean): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    assertCleanArg(arg, "pytest argument");

    if (arg === "-k" || arg === "-W") {
      const next = args[i + 1];
      if (!next) {
        throw new SecurityError(`pytest flag "${arg}" requires a value.`);
      }
      assertCleanArg(next, `pytest ${arg} value`);
      if (!/^[a-zA-Z0-9_\- .:]+$/.test(next)) {
        throw new SecurityError(`Unsafe pytest filter value for "${arg}": "${next}"`);
      }
      i++;
      continue;
    }

    if (arg.startsWith("-")) {
      if (!SAFE_PYTEST_FLAG_PATTERN.test(arg)) {
        throw new SecurityError(`Disallowed pytest flag: "${arg}"`);
      }
      continue;
    }

    assertSafeTestTarget(arg, workspaceRoot, requireExist);
  }
}

function validateFlaskArgs(args: string[]): void {
  if (args.length === 0) {
    throw new SecurityError("flask requires an approved subcommand (--help, --version, config, routes).");
  }

  let idx = 0;
  if (args[idx] === "--app" || args[idx] === "-A") {
    const appTarget = args[idx + 1];
    if (!appTarget || !SAFE_MODULE_SPEC_PATTERN.test(appTarget)) {
      throw new SecurityError(`Invalid flask --app specification: "${appTarget ?? ""}"`);
    }
    idx += 2;
  }

  const remaining = args.slice(idx);
  if (remaining.length === 0) {
    throw new SecurityError("flask requires an approved subcommand (--help, --version, config, routes).");
  }

  const subcommand = remaining[0];
  const allowedSubcommands = new Set(["--help", "-h", "--version", "config", "routes"]);
  if (!allowedSubcommands.has(subcommand)) {
    throw new SecurityError(
      `Disallowed flask subcommand "${subcommand}". Approved subcommands: --help, --version, config, routes.`
    );
  }

  for (const extra of remaining.slice(1)) {
    if (extra !== "--help" && extra !== "-h") {
      throw new SecurityError(`Disallowed flask option "${extra}".`);
    }
  }
}

/**
 * Validates an executable and argument array against PatchPilot's strict command policy.
 */
export function validateCommandSpec(
  executable: string,
  args: string[],
  workspaceRoot: string,
  options: { requireTestTargetExist?: boolean } = {}
): ValidatedCommandSpec {
  if (!executable || typeof executable !== "string") {
    throw new SecurityError("Executable must be a non-empty string.");
  }

  // Reject path-qualified executables like /bin/sh or C:\Windows\System32\cmd.exe
  if (executable.includes("/") || executable.includes("\\") || executable.includes(" ")) {
    throw new SecurityError(
      `Executable "${executable}" must be a bare allowlisted command name without paths or arguments.`
    );
  }

  const normalizedExe = executable.trim().toLowerCase();
  if (!ALLOWED_EXECUTABLES.has(normalizedExe)) {
    throw new SecurityError(
      `Disallowed executable "${executable}". Permitted executables: ${Array.from(ALLOWED_EXECUTABLES).join(", ")}.`
    );
  }

  if (!Array.isArray(args)) {
    throw new SecurityError("Command arguments must be provided as an array of strings.");
  }
  if (args.length > 24) {
    throw new SecurityError("Too many command arguments (maximum 24).");
  }

  for (const arg of args) {
    assertCleanArg(arg, "command argument");
  }

  const requireExist = options.requireTestTargetExist ?? false;

  switch (normalizedExe) {
    case "pytest": {
      validatePytestArgs(args, workspaceRoot, requireExist);
      break;
    }

    case "flask": {
      validateFlaskArgs(args);
      break;
    }

    case "python":
    case "python3": {
      if (args.length < 2 || args[0] !== "-m") {
        throw new SecurityError(
          `Disallowed ${normalizedExe} invocation. Only "${normalizedExe} -m <pytest|unittest|flask> ..." is permitted.`
        );
      }
      const mod = args[1];
      const rest = args.slice(2);
      if (mod === "pytest") {
        validatePytestArgs(rest, workspaceRoot, requireExist);
      } else if (mod === "flask") {
        validateFlaskArgs(rest);
      } else if (mod === "unittest") {
        for (const uArg of rest) {
          if (uArg === "discover" || uArg === "-v" || uArg === "-q" || uArg === "-f") {
            continue;
          }
          assertSafeTestTarget(uArg, workspaceRoot, requireExist);
        }
      } else {
        throw new SecurityError(
          `Disallowed python module "${mod}". Only pytest, unittest, and flask modules are permitted.`
        );
      }
      break;
    }

    case "node": {
      if (args.length < 2 || args[0] !== "--test") {
        throw new SecurityError(
          'Disallowed node invocation. Only "node --test <approved-test-file>" is permitted.'
        );
      }
      for (const target of args.slice(1)) {
        if (target.startsWith("-")) {
          throw new SecurityError(`Disallowed node flag "${target}".`);
        }
        assertSafeTestTarget(target, workspaceRoot, requireExist);
      }
      break;
    }

    case "npm": {
      const joined = args.join(" ");
      const allowedNpmCommands = new Set([
        "test",
        "run test",
        "run test:unit",
        "run lint",
        "run compile",
        "run build",
      ]);
      if (!allowedNpmCommands.has(joined)) {
        throw new SecurityError(
          `Disallowed npm command "npm ${joined}". Only approved test/lint/build scripts are permitted.`
        );
      }
      break;
    }

    case "git": {
      const sub = args[0];
      if (sub === "status") {
        for (const flag of args.slice(1)) {
          if (flag !== "--porcelain" && flag !== "--short" && flag !== "-s") {
            throw new SecurityError(`Disallowed git status option "${flag}".`);
          }
        }
      } else if (sub === "diff") {
        for (const flag of args.slice(1)) {
          if (flag !== "--stat" && flag !== "--name-only" && flag !== "--cached") {
            throw new SecurityError(`Disallowed git diff option "${flag}".`);
          }
        }
      } else if (sub === "rev-parse") {
        const joined = args.slice(1).join(" ");
        if (joined !== "HEAD" && joined !== "--abbrev-ref HEAD" && joined !== "--short HEAD") {
          throw new SecurityError(`Disallowed git rev-parse arguments: "${joined}".`);
        }
      } else if (sub === "branch") {
        if (args.length !== 2 || args[1] !== "--show-current") {
          throw new SecurityError('Only "git branch --show-current" is permitted.');
        }
      } else if (sub === "log") {
        for (let i = 1; i < args.length; i++) {
          const a = args[i];
          if (a === "--oneline") {
            continue;
          }
          if (a === "-n" && args[i + 1] && /^\d+$/.test(args[i + 1]) && Number(args[i + 1]) <= 50) {
            i++;
            continue;
          }
          throw new SecurityError(`Disallowed git log option "${a}".`);
        }
      } else {
        throw new SecurityError(
          `Disallowed git subcommand "${sub ?? ""}". Only read-only git inspection commands are permitted.`
        );
      }
      break;
    }
  }

  return {
    executable: normalizedExe,
    args: [...args],
    displayCommand: `${normalizedExe} ${args.join(" ")}`.trim(),
  };
}

function terminateChildTree(pid: number | undefined): void {
  if (!pid) {
    return;
  }
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      killer.unref();
    } catch {
      // Fallback handled by child.kill()
    }
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process may already have exited
    }
  }
}

/**
 * Executes a validated command spec inside options.cwd with strict timeout, output bounds,
 * sanitized environment, shell: false, and AbortSignal cancellation.
 */
export async function executeSafeWorkspaceCommand(
  spec: ValidatedCommandSpec,
  options: CommandExecutionOptions
): Promise<CommandExecutionResult> {
  const timeoutMs = Math.min(
    Math.max(options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, 500),
    MAX_COMMAND_TIMEOUT_MS
  );
  const env = sanitizeProcessEnv(process.env, options.extraEnv);
  const startTime = Date.now();

  if (options.signal?.aborted) {
    return {
      executable: spec.executable,
      args: spec.args,
      exitCode: 130,
      passed: false,
      stdout: "",
      stderr: "Execution cancelled prior to launch.",
      durationMs: 0,
      timedOut: false,
      cancelled: true,
      truncated: false,
    };
  }

  // On Windows, npm is npm.cmd; resolve safely without shell interpolation where possible
  const spawnExe =
    process.platform === "win32" && spec.executable === "npm" ? "npm.cmd" : spec.executable;

  return new Promise<CommandExecutionResult>((resolve) => {
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const child = spawn(spawnExe, spec.args, {
      cwd: options.cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finalize = (exitCode: number, fallbackStderr?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }

      const rawStdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
      const rawStderr = (
        Buffer.concat(stderrChunks).toString("utf8").trim() ||
        fallbackStderr ||
        ""
      ).trim();

      const secrets = options.secretsToRedact ?? [];
      resolve({
        executable: spec.executable,
        args: spec.args,
        exitCode,
        passed: !timedOut && !cancelled && exitCode === 0,
        stdout: sanitizeSecretText(rawStdout, secrets),
        stderr: sanitizeSecretText(rawStderr, secrets),
        durationMs: Date.now() - startTime,
        timedOut,
        cancelled,
        truncated,
      });
    };

    const onAbort = () => {
      cancelled = true;
      terminateChildTree(child.pid);
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Ignore
        }
        finalize(130, "Execution cancelled via AbortSignal");
      }, 150);
    };

    if (options.signal) {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      terminateChildTree(child.pid);
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Ignore
        }
        finalize(124, `Command timed out after ${timeoutMs}ms`);
      }, 150);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutBytes < MAX_OUTPUT_BYTES) {
        const remaining = MAX_OUTPUT_BYTES - stdoutBytes;
        const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        stdoutChunks.push(slice);
        stdoutBytes += slice.length;
        if (chunk.length > remaining) {
          truncated = true;
        }
      } else {
        truncated = true;
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes < MAX_OUTPUT_BYTES) {
        const remaining = MAX_OUTPUT_BYTES - stderrBytes;
        const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        stderrChunks.push(slice);
        stderrBytes += slice.length;
        if (chunk.length > remaining) {
          truncated = true;
        }
      } else {
        truncated = true;
      }
    });

    child.on("error", (err) => {
      finalize(1, `Failed to spawn "${spec.executable}": ${err.message}`);
    });

    child.on("close", (code) => {
      if (cancelled) {
        finalize(130, "Execution cancelled via AbortSignal");
      } else if (timedOut) {
        finalize(124, `Command timed out after ${timeoutMs}ms`);
      } else {
        finalize(typeof code === "number" ? code : 1);
      }
    });
  });
}
