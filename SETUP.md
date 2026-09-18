# Setup Guide

Step by step, from nothing to generating an image from your MCP client. Roughly 10 minutes.

---

## Step 1 — Install Node.js 20+

```bash
node --version    # must print v20.x or newer
```

If not, install from [nodejs.org](https://nodejs.org/) or via `nvm`.

## Step 2 — Install and log in to the Codex CLI

```bash
npm install -g @openai/codex
codex login
codex --version   # should print e.g. codex-cli 0.155.0
```

`codex login` opens a browser. A ChatGPT subscription is enough — you do **not** need a
separate API key, including for image generation.

**Verify Codex actually works before going further:**

```bash
mkdir codex-test && cd codex-test
codex exec --sandbox workspace-write --skip-git-repo-check "create hello.txt containing OK"
cat hello.txt
```

If that fails, fix it now. This server only wraps the CLI; it cannot fix a broken Codex.

## Step 3 — Build the server

```bash
git clone https://github.com/ossmalaysia/codex-local-mcp.git
cd codex-local-mcp
npm install
npm run build
npm test          # 11 tests should pass, no Codex needed
```

## Step 4 — Collect your absolute paths

MCP clients start servers with a minimal environment, where bare `node` and `codex` often do
not resolve. Get the real paths:

**macOS / Linux**
```bash
which node        # e.g. /usr/local/bin/node
which codex       # e.g. /usr/local/bin/codex
pwd               # the codex-local-mcp folder you are in
```

**Windows (PowerShell)**
```powershell
(Get-Command node).Source     # e.g. C:\Program Files\nodejs\node.exe
(Get-Command codex).Source    # may print codex.ps1 - use the .cmd next to it
Get-Location
```

> **Windows note:** if `Get-Command codex` prints a `.ps1` file, use the `.cmd` file in the
> same folder (`codex.cmd`). That is the one a spawned process can execute.

You need four values:

| Value | Example (macOS) | Example (Windows) |
|---|---|---|
| node path | `/usr/local/bin/node` | `C:/Program Files/nodejs/node.exe` |
| server entry | `/Users/you/codex-local-mcp/dist/index.js` | `C:/dev/codex-local-mcp/dist/index.js` |
| codex path | `/usr/local/bin/codex` | `C:/Users/you/AppData/Roaming/npm/codex.cmd` |
| workspace root | `/Users/you/codex-workspaces` | `C:/dev/codex-workspaces` |

Forward slashes work on Windows too, and avoid escaping headaches in JSON.

## Step 5 — Configure your client

### Claude Desktop

Open the config file:

- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

Or use **Settings → Developer → Edit config**.

Add a `mcpServers` section (keep any existing keys in the file — merge, don't replace):

```json
{
  "mcpServers": {
    "codex": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/codex-local-mcp/dist/index.js"],
      "env": {
        "CODEX_BIN": "/absolute/path/to/codex",
        "CODEX_MCP_ROOT": "/absolute/path/to/codex-workspaces",
        "CODEX_TIMEOUT_SEC": "600"
      }
    }
  }
}
```

**Then fully quit Claude Desktop and reopen it.** Closing the window is not enough — it keeps
running in the system tray / menu bar. The config is read once at launch.

### Claude Code

```bash
claude mcp add codex -s user \
  -e CODEX_MCP_ROOT=/absolute/path/to/codex-workspaces \
  -- /absolute/path/to/node /absolute/path/to/codex-local-mcp/dist/index.js

claude mcp list      # should show: codex ✓ Connected
```

## Step 6 — Verify

In Claude Desktop, check **Settings → Developer → Local MCP servers**. `codex` should be
listed as **Running**, showing your command, arguments and environment variables.

Then, in a new chat:

> use codex to create a file called hello.txt containing the word OK

You should get back an exit code of 0 and `hello.txt` in the file list. Then try:

> use codex to generate an image of a red sports car at sunset

The image should open in your default image viewer, and the file path appears in the chat.

---

## Troubleshooting

### `codex` shows as failed, or tools don't appear

1. Fully quit the client (system tray / menu bar), then reopen.
2. Check the config file is valid JSON — a trailing comma breaks the whole file silently.
3. Confirm the paths are absolute and correct.
4. Read the logs (below).

### Where the logs are

**Claude Desktop**

- Windows: `%LOCALAPPDATA%\Claude\logs\mcp-server-codex.log`
- macOS: `~/Library/Logs/Claude/mcp-server-codex.log`

Or click **View logs** next to the server in Settings → Developer.

Useful lines:

| Line | Meaning |
|---|---|
| `Server started and connected successfully` | The server launched fine |
| `result(1 blocks)` | Text only — no image was returned |
| `result(3 blocks)` | Text + label + image — an image came through |
| `Could not run "codex"` | `CODEX_BIN` is wrong or Codex is not installed |

### "Could not run codex"

`CODEX_BIN` is wrong. Set it to the absolute path. On Windows use `codex.cmd`, not
`codex.ps1`. Verify the exact path exists.

### My code changes aren't taking effect

The client loads the server **once, at launch**, into memory. Rebuilding on disk changes
nothing for a running process.

```bash
npm run build
```

…then fully quit and reopen the client. Opening a new chat *sometimes* respawns the server,
but do not rely on it — check the process start time against your build time if unsure.

### The image generated but I can't see it

Expected. MCP delivers tool-result images to the **model's context**; clients do not render
them into the chat transcript. That is why `open` defaults to `true` and the image opens in
your OS viewer. The full-resolution file path is always in the response.

If the file is large, the model receives a downscaled preview — the original on disk is
untouched.

### Runs time out

Raise `CODEX_TIMEOUT_SEC` (default 300). High-quality or large images take longer. The
ceiling is `CODEX_MAX_TIMEOUT_SEC`, default 1800.

### Codex can't reach the network

Network access is on by default. If you set `CODEX_NETWORK_ACCESS=false`, package installs
and any API call from inside the sandbox will fail.

### Windows: it works in a terminal but not from the client

Almost always the minimal environment. Use absolute paths for both `command` and `CODEX_BIN`.
If it still fails, the log will show the exact spawn error.
