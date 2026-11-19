/**
 * PatchPilot Secret Filtering & Log/Environment Sanitization
 *
 * Prevents API keys, bearer tokens, private keys, and sensitive credentials
 * from leaking into logs, model context, UI output, or child process environments.
 */

const SECRET_ENV_NAME_PATTERN =
  /(key|secret|token|password|passwd|auth|credential|cookie|private|openai|anthropic|gemini|trueforge|aws_|gcp_|azure_|huggingface|groq|mistral|cohere|deepseek)/i;

const SAFE_ENV_ALLOWLIST = new Set([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "COMSPEC",
  "WINDIR",
  "OS",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "NODE_ENV",
  "VIRTUAL_ENV",
  "CONDA_PREFIX",
  "PYTHONPATH",
  "PYTHONIOENCODING",
  "PYTHONUTF8",
  "FLASK_APP",
  "FLASK_DEBUG",
  "FLASK_ENV",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "COMMONPROGRAMFILES",
]);

const SENSITIVE_DIRECTORY_SEGMENTS = new Set([
  ".git",
  ".ssh",
  ".aws",
  ".kube",
  ".gnupg",
  ".patchpilot",
]);

const SENSITIVE_FILENAMES = new Set([
  ".env",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".htpasswd",
  ".bash_history",
  ".zsh_history",
  "id_rsa",
  "id_rsa.pub",
  "id_ed25519",
  "id_ed25519.pub",
  "id_ecdsa",
  "id_dsa",
  "credentials",
  "credentials.json",
  "secrets.json",
  "secrets.yaml",
  "secrets.yml",
  "token.json",
]);

const SENSITIVE_EXTENSIONS = new Set([
  ".pem",
  ".key",
  ".pfx",
  ".p12",
  ".jks",
  ".keystore",
  ".secret",
  ".token",
]);

/**
 * Redacts tokens, API keys, and credential headers from arbitrary text.
 */
export function sanitizeSecretText(text: string, extraSecrets: readonly string[] = []): string {
  let sanitized = text;

  for (const secret of extraSecrets) {
    if (secret && secret.length >= 6) {
      sanitized = sanitized.split(secret).join("[REDACTED]");
    }
  }

  return sanitized
    .replace(/(Authorization["':\s=]+)(?:Bearer|Basic|Token)\s+[^\s"',;}\]]+/gi, "$1[REDACTED]")
    .replace(/(x-patchpilot-token["':\s=]+)[^\s"',;}\]]+/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9_\-.~+/=]{8,}/gi, "$1[REDACTED]")
    .replace(/\bsk-(?:proj-|ant-)?[A-Za-z0-9_\-]{8,}\b/g, "sk-[REDACTED]")
    .replace(/\bAIza[0-9A-Za-z\-_]{20,}\b/g, "AIza[REDACTED]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g, "[REDACTED_GH_TOKEN]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GH_TOKEN]")
    .replace(/\bsec-patchpilot-[A-Za-z0-9_\-]{8,}\b/g, "sec-patchpilot-[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)["':\s=]+)[^\s"',;}\]]{6,}/gi, "$1[REDACTED]")
    .replace(/(token["':\s=]+)[A-Za-z0-9_\-.]{8,}/gi, "$1[REDACTED]");
}

/**
 * Returns true if the given relative path refers to a protected/secret file or directory.
 */
export function isSensitiveFilePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/").trim();
  if (!normalized) {
    return false;
  }

  const segments = normalized.split("/").filter((s) => s.length > 0 && s !== ".");
  for (const seg of segments) {
    const lower = seg.toLowerCase();
    if (SENSITIVE_DIRECTORY_SEGMENTS.has(lower)) {
      return true;
    }
  }

  const base = segments[segments.length - 1]?.toLowerCase() ?? "";
  if (!base) {
    return false;
  }

  // Allow explicitly sanitized example files like .env.example / .env.sample / .env.template
  if (base === ".env.example" || base === ".env.sample" || base === ".env.template") {
    return false;
  }

  if (base === ".env" || base.startsWith(".env.")) {
    return true;
  }

  if (SENSITIVE_FILENAMES.has(base)) {
    return true;
  }

  if (base.startsWith("service-account") && base.endsWith(".json")) {
    return true;
  }

  for (const ext of SENSITIVE_EXTENSIONS) {
    if (base.endsWith(ext)) {
      return true;
    }
  }

  return false;
}

/**
 * Produces a sanitized copy of process.env safe for spawning verification commands
 * inside a disposable execution overlay. Strips API keys, tokens, and test harness vars.
 */
export function sanitizeProcessEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
  extraSafeOverrides: Record<string, string> = {}
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value === undefined) {
      continue;
    }
    const upper = key.toUpperCase();
    if (upper === "NODE_TEST_CONTEXT") {
      continue;
    }
    if (SECRET_ENV_NAME_PATTERN.test(key)) {
      continue;
    }
    if (SAFE_ENV_ALLOWLIST.has(upper)) {
      clean[key] = value;
    }
  }

  for (const [key, value] of Object.entries(extraSafeOverrides)) {
    if (!SECRET_ENV_NAME_PATTERN.test(key)) {
      clean[key] = value;
    }
  }

  return clean;
}
