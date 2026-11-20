# PatchPilot — Official Forge-a-thon Demo Runbook (Tasks A, B, and C)

Follow these exact steps in order for a reproducible demonstration on `pallets/flask` release `3.1.3` (commit `22d92470`).

---

## 0. Prerequisites & Clean Benchmark Setup

### Software Requirements
- **Node.js:** `>= 22.14.0` (verified on `v24.19.0`)
- **Visual Studio Code:** `>= 1.101.0` (verified on `1.146.0`)
- **Python:** `3.10+` with `pytest`
- **Git:** `2.30+`
- **TrueForge Server:** `@truefoundry/trueforge@0.185.1` (or `@latest`) with a valid LLM provider configured in TrueForge Settings -> Model Providers

### Step 0.1 — Build PatchPilot
```powershell
git clone https://github.com/madhura200227/PatchPilot.git
cd PatchPilot
npm install
npm run compile
```

### Step 0.2 — Prepare Isolated `pallets/flask` 3.1.3 Benchmark Clone (Outside PatchPilot)
```powershell
$flaskDir = Join-Path $env:TEMP "patchpilot-flask-benchmark"
git clone --depth 1 --branch 3.1.3 https://github.com/pallets/flask.git $flaskDir
git -C $flaskDir rev-parse --short HEAD   # Expected: 22d9247 (22d924701a6ae2e4cd01e9a15bbaf3946094af65)

# Create isolated Python venv and install Flask + pytest in editable mode
python -m venv "$flaskDir\.venv"
& "$flaskDir\.venv\Scripts\Activate.ps1"
pip install -e $flaskDir pytest
pytest "$flaskDir\tests\test_cli.py" -q   # Verify baseline tests pass
```

### Step 0.3 — Start Local TrueForge Server with Explicit Loopback Allowlist
TrueForge enables SSRF protection by default. Do **not** disable SSRF protection globally; pass only the narrow documented loopback allowlist and bind `HOST=127.0.0.1`:

```powershell
$env:HOST = "127.0.0.1"
$env:OUTBOUND_URL_ALLOWED_HOSTS = '["127.0.0.1","localhost"]'
npx --yes @truefoundry/trueforge@0.185.1 --port 8790
```

> **Note:** On Windows without `HOST=127.0.0.1`, TrueForge may listen on IPv6 `localhost` (`::1`) only. Setting `HOST=127.0.0.1` ensures `http://127.0.0.1:8790` works consistently.

### Step 0.4 — Configure Your Model in TrueForge UI
1. Open `http://127.0.0.1:8790` in your browser.
2. Navigate to **Settings -> Model Providers**, add your provider (e.g., OpenAI, Anthropic, Gemini, etc.) and API key, and enable a model.
3. PatchPilot **never** asks for or stores upstream LLM provider keys.

### Step 0.5 — Launch PatchPilot in VS Code Extension Development Host
```powershell
code --extensionDevelopmentPath=D:\Projects\PatchPilot "$env:TEMP\patchpilot-flask-benchmark"
```
Inside the Extension Development Host window:
1. Trust the `patchpilot-flask-benchmark` workspace when prompted.
2. Open the **PatchPilot** sidebar icon in the Activity Bar (or run `PatchPilot: Open Agent Panel`).
3. Click **Configure** (or run `PatchPilot: Configure TrueForge`):
   - Confirm server URL `http://127.0.0.1:8790`.
   - Select your configured TrueForge model from the QuickPick list.
   - PatchPilot automatically starts its loopback out-of-process MCP server (`dist/mcpServer.js`), registers `patchpilot-workspace` in TrueForge, verifies discovery of all 8 tools, and creates/updates the `patchpilot` agent with `preload: false`, `compaction.enabled: true`, `largeToolResponse.enabled: true`, and human approvals for `propose_edit` and `run_workspace_command`.

---

## 1. TASK A — INLINE EDIT

1. In the Extension Development Host, open:
   `src/flask/helpers.py`
2. Select the entire `get_debug_flag` function.
3. Press **`Ctrl+Shift+I`** (macOS: **`Cmd+Shift+I`**) — or right-click -> **PatchPilot: Inline Edit Selection**.
4. Enter this exact instruction:
   ```text
   Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.
   ```
5. Observe:
   - TrueForge executes the turn and requests approval for `propose_edit`.
   - Click **Approve Tool Call** in the PatchPilot sidebar.
   - Notice `git status` on disk is still **CLEAN** (the edit is staged only in PatchPilot's isolated proposal store).
   - The **PatchPilot Change Review** panel opens automatically showing the proposed diff hunk(s).
6. Click **Accept Hunk** on the reviewed hunk, then click **Apply Accepted Changes**.
7. Run the official verification command in the integrated terminal (with Flask venv active):
   ```powershell
   $env:FLASK_DEBUG="off"; python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
   ```
   **Expected output:** `False`
8. *(Optional Undo Demonstration)*: Run `PatchPilot: Undo Last Apply` (or click **Undo Last Apply**) to prove safe hash-verified restoration, then re-apply or keep clean before Task B.

---

## 2. TASK B — AGENT MODE (AUTONOMOUS MULTI-FILE DISCOVERY)

1. Reset or keep clean baseline (`git -C $flaskDir status` clean if desired), and click **New Session** in the PatchPilot sidebar.
2. **Do NOT mention any filenames** in the prompt. Enter this exact instruction:
   ```text
   Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.
   ```
3. Observe in the **PatchPilot Agent Panel**:
   - **Context Assembly Plan** displays estimated budget usage (e.g. `~2,827 / 16,000 est. tokens`) and discovery rationale.
   - **Tool Activity Timeline** streams TrueForge independently calling `search_workspace`, `get_context_plan`, `read_workspace_file`, and `read_workspace_symbol` to discover `src/flask/cli.py`, `tests/test_cli.py`, and `docs/cli.rst` (3+ files).
   - TrueForge requests human approval for `propose_edit` on each file and for `run_workspace_command` to execute `pytest tests/test_cli.py -q` and `flask --help` / `flask config` inside the **disposable execution overlay** (host working tree remains untouched during test runs!).
4. Open **Diff Review**, inspect every file and individual hunk, accept the verified hunks, and click **Apply Accepted Changes**.
5. Confirm verification in the terminal:
   ```powershell
   pytest tests/test_cli.py -q
   flask --help
   python -m flask --app tests.test_apps.cliapp.app config
   ```
   Confirm JSON output with secret-bearing keys (`SECRET_KEY`, etc.) masked as `"***"`.

---

## 3. TASK C — RESILIENCE (FAILURE HANDLING WITHOUT WORKSPACE MUTATIONS)

1. Ensure `git -C $flaskDir status` is clean (or record current `git diff` / `git status`).
2. Configure TrueForge to simulate failure using either:
   - **Unreachable endpoint:** Set `patchpilot.trueforge.baseUrl` to `http://127.0.0.1:18799`, **OR**
   - **Invalid provider key:** Replace the model provider key in TrueForge Settings with an invalid key (do not commit or log secrets).
3. Repeat Task A (`src/flask/helpers.py`, select `get_debug_flag`, press `Ctrl+Shift+I`, submit the Task A instruction).
4. Observe:
   - VS Code editor remains completely responsive.
   - PatchPilot surfaces a clear, sanitized failure message (retries transient transport failures with bounded backoff; does **not** blindly retry 401 auth errors).
   - No proposed edits are applied.
5. Verify in terminal:
   ```powershell
   git -C $flaskDir status --short
   ```
   **Expected:** Zero files modified by the failed task.
