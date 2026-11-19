import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

function findInstalledVsCodeExecutable(): string | undefined {
  if (process.env.VSCODE_EXECUTABLE_PATH && fs.existsSync(process.env.VSCODE_EXECUTABLE_PATH)) {
    return process.env.VSCODE_EXECUTABLE_PATH;
  }

  if (process.platform === "win32") {
    const candidates = [
      path.join(process.env.LOCALAPPDATA || "", "Programs", "Microsoft VS Code", "Code.exe"),
      path.join(process.env.ProgramFiles || "C:\\Program Files", "Microsoft VS Code", "Code.exe"),
    ];
    for (const c of candidates) {
      if (c && fs.existsSync(c)) {
        return c;
      }
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, "../../..");
  const extensionTestsPath = path.resolve(__dirname, "./suite/index");

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "patchpilot-vscode-e2e-"));
  const tmpWorkspace = path.join(tmpBase, "workspace");
  const tmpUserData = path.join(tmpBase, "user-data");
  const tmpExtensions = path.join(tmpBase, "extensions");

  fs.mkdirSync(path.join(tmpWorkspace, "src"), { recursive: true });
  fs.mkdirSync(tmpUserData, { recursive: true });
  fs.mkdirSync(tmpExtensions, { recursive: true });

  // Seed deterministic disposable Python sample file with distant regions for multi-hunk review
  const samplePy = [
    "import os",
    "",
    "def get_debug_flag() -> bool:",
    '    """Get whether debug mode should be enabled."""',
    '    val = os.environ.get("FLASK_DEBUG")',
    '    return bool(val and val.lower() not in {"0", "false", "no"})',
    "",
    "# filler 1",
    "# filler 2",
    "# filler 3",
    "# filler 4",
    "# filler 5",
    "# filler 6",
    "# filler 7",
    "# filler 8",
    "",
    "def helper_two() -> int:",
    "    return 1",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(tmpWorkspace, "src", "helpers.py"), samplePy, "utf8");

  // Pre-configure isolated VS Code user settings (trust workspace + unreachable TrueForge port for resilience check)
  const userSettingsDir = path.join(tmpUserData, "User");
  fs.mkdirSync(userSettingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(userSettingsDir, "settings.json"),
    JSON.stringify(
      {
        "security.workspace.trust.enabled": false,
        "patchpilot.trueforge.baseUrl": "http://127.0.0.1:18799",
        "patchpilot.trueforge.agentName": "patchpilot",
        "patchpilot.trueforge.requestTimeoutSeconds": 3,
      },
      null,
      2
    ),
    "utf8"
  );

  try {
    // Ensure Code.exe boots as full Electron VS Code rather than Node if launched from an Electron-hosted terminal
    delete process.env.ELECTRON_RUN_AS_NODE;

    const vscodeExecutablePath = findInstalledVsCodeExecutable();
    console.log(
      `[VS Code E2E] Launching Extension Development Host (${vscodeExecutablePath || "downloaded"}) with workspace: ${tmpWorkspace}`
    );

    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        tmpWorkspace,
        `--user-data-dir=${tmpUserData}`,
        `--extensions-dir=${tmpExtensions}`,
        "--disable-extensions",
        "--skip-welcome",
        "--skip-release-notes",
      ],
    });
  } finally {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      // Best-effort temp cleanup
    }
  }
}

main().catch((err) => {
  console.error("[VS Code E2E] Failed to run Extension Development Host tests:", err);
  process.exit(1);
});
