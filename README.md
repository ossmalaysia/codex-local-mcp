<p align="center">
  <img src="assets/banner.png" alt="codex-local-mcp - drive the local Codex CLI from any LLM" width="640">
</p>

<p align="center">
  <a href="https://github.com/ossmalaysia/codex-local-mcp/actions/workflows/ci.yml"><img src="https://github.com/ossmalaysia/codex-local-mcp/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/ossmalaysia/codex-local-mcp/releases/latest"><img src="https://img.shields.io/github/v/release/ossmalaysia/codex-local-mcp" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
</p>

# codex-local-mcp

An MCP server that lets Claude, or any other MCP client, drive the **Codex CLI on your own computer**.

Ask for an image or a coding task in plain English. Codex does the work inside a sandboxed
workspace folder on your machine, and the server returns Codex's output, the files it created,
and image previews.

Codex generates images natively, so image generation needs **no image API key**. Your existing
ChatGPT sign-in for Codex is enough.

> [!WARNING]
> **This runs code on your computer.** Anything that can call these tools can make Codex run
> code as you, inside its sandbox. Read [SECURITY.md](SECURITY.md) before you use it.

## Choose how to run it

| | Windows app | Command-line server |
|---|---|---|
| Best for | Using Codex from Claude on the web, desktop, or phone | Claude Desktop, Claude Code, or other local MCP clients |
| Platform | Windows 10/11 x64 | Windows, macOS, Linux |
| Install | Setup EXE, no other software needed | Node.js 20+ and the Codex CLI |
| Connection | Remote HTTPS through Cloudflare, with OAuth login | Local stdio, or remote HTTP with OAuth |
| Guide | **[Windows app guide](docs/WINDOWS-GUIDE.md)** | **[Setup guide](SETUP.md)** |

## Windows app

<p align="center">
  <img src="docs/images/5-activity.png" alt="The Activity page shows an image task, its prompt, settings, and output files" width="720">
</p>

1. Download `CodexLocalMCP-<version>-windows-x64-setup.exe` from the
   [latest release](https://github.com/ossmalaysia/codex-local-mcp/releases/latest) and install it.
2. Choose a workspace folder, sign in to OpenAI, and generate an MCP password.
3. Select **Start connection**, then copy the URL.
4. In Claude, add the URL as a **custom connector** and sign in with the MCP password.

The **[Windows app guide](docs/WINDOWS-GUIDE.md)** shows each step with screenshots and explains
how to generate images, read the activity, and fix common problems.

What the app does for you:

- **Sandboxed by default.** Codex can write only in your workspace folder. Before each start,
  the app tests that the sandbox blocks access to its private data.
- **Secure remote access.** A Cloudflare Tunnel gives Claude an HTTPS address. Use a temporary
  Quick Tunnel with no account, or a fixed address on your own domain.
- **Stays signed in.** Claude stays connected for 30 days across restarts and updates.
- **Parallel images.** A request for several images runs up to four Codex sessions at once.
- **Live activity.** See each task's stages, settings, output files, and token usage.
  You can also turn on a view of the prompts that Claude sends, so you can improve them.
- **Signed updates.** The app checks for new versions, verifies each download's signature,
  and reconnects after the update.

The app contains a Rust MCP service and a Rust/Tauri desktop. It does not need Node.js.
See the [native build instructions](native/README.md) to build it from source.

## Command-line server

The TypeScript server runs on any operating system. MCP clients start it as a local process.

### Requirements

- Node.js 20 or newer
- [Codex CLI](https://github.com/openai/codex), installed and signed in

### Install

New to this? Follow the **[step-by-step setup guide](SETUP.md)**. It covers how to find your
paths, configure each client, test the setup, and fix problems.

```bash
npm install -g @openai/codex   # the Codex CLI itself
codex login                    # one time

git clone https://github.com/ossmalaysia/codex-local-mcp.git
cd codex-local-mcp
npm install
npm run build
```

### Connect a client

The default transport is **stdio**: the client starts the server as a child process.
For remote access through HTTPS, see [Remote access with OAuth](#remote-access-with-oauth).

Use **absolute paths** for `command` and for `CODEX_BIN`. MCP clients start servers with a
minimal environment, in which `node` and `codex` may not resolve.

#### Claude Desktop

Add this to `claude_desktop_config.json`, then fully quit and reopen the app.

- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

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

On Windows, the values look like `C:/Program Files/nodejs/node.exe` and
`C:/Users/you/AppData/Roaming/npm/codex.cmd`. Forward slashes work.
Find the paths with `which node` and `which codex` (macOS, Linux), or with
`(Get-Command node).Source` and `(Get-Command codex).Source` (PowerShell).

#### Claude Code

```bash
claude mcp add codex -s user -- node /absolute/path/to/codex-local-mcp/dist/index.js
```

#### Other clients

Any MCP client that can start a stdio server works. Point it at
`node /absolute/path/to/dist/index.js`.

## Remote access with OAuth

HTTP mode serves `/mcp` over Streamable HTTP. It includes a browser login, OAuth discovery,
dynamic client registration, and authorization codes with PKCE S256.

This mode serves **one trusted owner**. All authorized clients share the local Codex account,
jobs, files, and workspace root. There are no separate accounts and no isolation between clients.

First run `codex login` on the server machine, with the same operating system account that
starts the server. The server checks `codex login status` at startup and before MCP requests.

### Built-in Cloudflare Tunnel

Install `cloudflared` first. Then run:

```bash
npm run build
npm run start:tunnel
```

The command asks for an administrator username and password if `CODEX_MCP_PASSWORD` is not set.
Use at least 24 characters for the password. These credentials stay in memory for the current
session. You never enter your OpenAI password into the MCP login page.

The server starts a Cloudflare Quick Tunnel and prints its public `/mcp` URL and the exact
`claude mcp add` command. No Cloudflare account or domain is needed. Keep the terminal open
while you use the connection, and press Ctrl+C to stop it. Each start creates a new address,
so clients must connect again.

Quick Tunnels are for testing. For a fixed address, configure a named tunnel and use the
manual setup below. See [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

For unattended startup, set `CODEX_MCP_USERNAME` and `CODEX_MCP_PASSWORD` first. You can also
set `CODEX_MCP_TUNNEL=quick` and run `npm start`. If `cloudflared` is not found, set
`CLOUDFLARED_BIN` to its absolute path. The tunnel uses a temporary empty configuration and
does not change your existing Cloudflare settings.

### Manual HTTPS setup

In PowerShell:

```powershell
$env:CODEX_MCP_TRANSPORT = "http"
$env:CODEX_MCP_PUBLIC_URL = "https://codex.example.com"
$env:CODEX_MCP_USERNAME = "admin"
$env:CODEX_MCP_PASSWORD = [System.Net.NetworkCredential]::new("", (Read-Host "MCP password (at least 24 characters)" -AsSecureString)).Password
$env:CODEX_MCP_ROOT = "D:/codex-workspaces"
# Set CODEX_BIN to your absolute Codex CLI path if required.
npm run build
npm start
```

On macOS or Linux, set the same environment variables before you run `npm start`.

The listener uses `127.0.0.1:3000` by default. Put an HTTPS reverse proxy or tunnel in front of
it, and forward the whole public origin, including `/authorize`, `/login`, `/register`,
`/token`, `/revoke`, and `/.well-known/*`. `CODEX_MCP_PUBLIC_URL` must be an HTTPS origin with no path.
For example, with Caddy:

```caddyfile
codex.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Then connect Claude Code and complete the browser login with the administrator username and password:

```bash
claude mcp add --transport http codex-remote https://codex.example.com/mcp
```

See the [Claude Code remote MCP documentation](https://code.claude.com/docs/en/mcp).

### Sessions and limits

- The MCP login approves access. Codex uses its own local OpenAI login, and the server never
  sends OpenAI tokens to clients.
- Access tokens expire after 15 minutes. Refresh tokens rotate, and reuse of an old refresh
  token or a revocation ends the whole sign-in.
- The TypeScript server keeps OAuth state in memory, so a restart requires a new sign-in.
  The Windows app saves sign-ins for 30 days (see [native/README.md](native/README.md)).
- Login allows 10 attempts per client IP every 15 minutes.
- Cross-origin browser requests to `/mcp` are refused.

| Variable | Default | Purpose |
|---|---|---|
| `CODEX_MCP_TRANSPORT` | `stdio` | Set `http` for remote access. |
| `CODEX_MCP_PUBLIC_URL` | `http://127.0.0.1:3000` | Public HTTPS origin. Loopback HTTP is allowed for local tests. |
| `CODEX_MCP_HOST` | `127.0.0.1` | Local listener address. |
| `CODEX_MCP_PORT` | `3000` | Local listener port. |
| `CODEX_MCP_USERNAME` | `admin` | Administrator login name. |
| `CODEX_MCP_PASSWORD` | *(required in HTTP mode)* | Administrator password, 24 characters to 1024 bytes. Never passed to Codex. |
| `CODEX_MCP_TUNNEL` | *(off)* | Set `quick` or `named` to start a Cloudflare Tunnel with HTTP mode. |
| `CODEX_MCP_TUNNEL_TOKEN` | *(named mode only)* | Remotely managed tunnel token. Never passed to Codex. |
| `CLOUDFLARED_BIN` | *(found on PATH)* | Absolute path of `cloudflared`. |

## Tools

| Tool | Main arguments | Description |
|---|---|---|
| `codex_run` | `prompt`, `workspace?`, `timeout_sec?`, `model?`, `reasoning_effort?`, `wait_sec?` | Run any task. |
| `codex_generate_image` | `prompt`, `count?`, `size?`, `quality?`, `output_format?`, `background?`, `target_file_kb?`, `workspace?`, `open?`, `wait_sec?` | Generate images. Your description is passed through as written. |
| `codex_job_result` | `job_id`, `wait_sec?` | Collect the result of a task that was still running. |
| `codex_read_artifact` | `path`, `max_bytes?` | Read a file from a workspace. |

Use the same `workspace` name across calls to keep working on the same files.
The [Windows app guide](docs/WINDOWS-GUIDE.md#6-generate-images) lists the image settings and
gives example requests.

### Long-running tasks

MCP clients built on the official SDK give up on a request after 60 seconds by default, and
image generation often takes longer. So a call waits up to `wait_sec` (default 45, maximum 50).
If Codex has finished, you get the result. If not, the call returns at once with:

```
status: running
job_id: a3b1d698-5754-490c-ab5d-bc1ea76149a2
workspace: /path/to/codex-workspaces/my-task
```

Codex keeps working. The model calls `codex_job_result` with the `job_id` until the task
finishes. Finished results stay available for one hour. Jobs are held in memory, so a server
restart loses the `job_id`, but the files remain in the workspace.

`codex_generate_image` defaults to `quality: "low"` and `size: "1024x1024"`, which is a fast
draft. `size` must be `WIDTHxHEIGHT` or `auto`. The size is a request to the image tool, so the
result reports each image's real dimensions. `open` defaults to `true` and opens each image in
your default viewer, because MCP clients give tool-result images to the model and do not
always show them in the chat.

### Images in the chat (experimental, TypeScript server only)

Set `CODEX_MCP_APP_VIEW=true` to show an image card **inside the chat** in clients that support
[MCP Apps](https://modelcontextprotocol.io/extensions/apps). The card shows progress and
collects the finished image itself. Other clients ignore it.

It is **off by default**. In Claude Desktop chats that reach the server through the desktop
app's device connection, the card stopped image calls from reaching the server. Enable it only
in a client where you have tested it.

## Configuration

All settings are optional. Set them in the client's `env` block.

| Variable | Default | Purpose |
|---|---|---|
| `CODEX_MCP_ROOT` | `~/.codex-mcp/workspaces` | Root for all workspaces. Nothing is written outside it. |
| `CODEX_BIN` | `codex` | Absolute path to the Codex CLI. |
| `CODEX_MODEL` | *(Codex default)* | Model override. |
| `CODEX_TIMEOUT_SEC` | `300` | Default timeout before a run is stopped. |
| `CODEX_MAX_TIMEOUT_SEC` | `1800` | Highest timeout a caller may request. |
| `CODEX_MAX_OUTPUT_CHARS` | `40000` | Output limit; the start and end are kept. |
| `CODEX_MAX_INLINE_IMAGE_BYTES` | `1048576` | Larger images are sent as a smaller preview. |
| `CODEX_MAX_REPORTED_FILES` | `200` | Limit on reported changed files. |
| `CODEX_NETWORK_ACCESS` | `true` | Set `false` to block network access for Codex commands. |
| `CODEX_SANDBOX_MODE` | `workspace-write` | `isolated` allows only the workspace and runtime paths; `read-only` refuses writes. The Windows app uses `isolated`. |
| `CODEX_WINDOWS_SANDBOX` | *(Codex default)* | Select `mxc` or `elevated`. An explicit choice never falls back to another backend. |
| `CODEX_RUNTIME_ROOT` | *(none)* | Read-only runtime folder for the isolated profile. Set by the Windows app. |
| `CODEX_PRIVATE_ROOT` | *(none)* | Private folder that sandboxed commands cannot access. Set by the Windows app. |
| `CODEX_WAIT_SEC` | `45` | How long a call waits before it returns a `job_id`. At most 50. |
| `CODEX_MAX_RUNNING_JOBS` | `4` | How many Codex jobs (and, in the Windows app, Codex processes) may run at once. |
| `CODEX_JOB_RETENTION_SEC` | `3600` | How long a finished result stays available. |
| `CODEX_MCP_APP_VIEW` | `false` | Show images in the chat as an MCP App card. Experimental; see above. |

## How it works

- **Workspaces are sandboxed.** Workspace names that would leave the root are refused. The
  default `workspace-write` policy limits writes to the workspace; the stricter `isolated`
  profile also limits reads.
- **Files are found by comparing the workspace** before and after each run, not by reading
  Codex's text output.
- **The prompt goes to Codex on stdin** (`codex exec ... -`), so prompt text can never become
  part of a command line.
- **Size limits count Base64 characters, not file bytes**, because encoding adds a third.
  Large images are reduced until the encoded preview fits. Originals are never changed.
- **Full-size files are linked, not embedded.** Each file is also returned as an MCP
  `resource_link` that a client can read with `resources/read`, inside the workspace root only.
- **Timeouts stop the whole process tree**, so a stuck build leaves nothing behind.

## Development

```bash
npm test          # uses a fake Codex: no CLI or API key needed
npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before you open a pull request, and
[CLAUDE.md](CLAUDE.md) for the architecture and the rules that the code must keep.
The Windows app has its own checks in [native/README.md](native/README.md).

CI runs the build, the tests, and `npm audit` on Ubuntu, Windows, and macOS with Node 20 and 22,
plus the native Rust checks and weekly CodeQL analysis.

## Versioning

The npm package follows [Semantic Versioning](https://semver.org/), with releases created from
[Conventional Commits](https://www.conventionalcommits.org/). The Windows app has its own version
number. All releases and their notes are on the
[Releases page](https://github.com/ossmalaysia/codex-local-mcp/releases).

While the major version is `0`, a minor release can contain breaking changes. The release notes
always state them.

## Security

Read [SECURITY.md](SECURITY.md). Report vulnerabilities privately through GitHub's
**Security → Report a vulnerability**, not as a public issue.

## License

[MIT](LICENSE) © OSS Malaysia
