<p align="center">
  <img src="assets/banner.png" alt="codex-local-mcp - drive the local Codex CLI from any LLM" width="640">
</p>

<p align="center">
  <a href="https://github.com/ossmalaysia/codex-local-mcp/actions/workflows/ci.yml"><img src="https://github.com/ossmalaysia/codex-local-mcp/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
</p>

# codex-local-mcp

An MCP server that lets any LLM drive your **local Codex CLI**.

The calling model sends a task in plain English. Codex writes and runs code inside an
isolated workspace folder on your machine. The server returns Codex's output, the list of
files it created, and the images inline.

Codex generates images natively, so `codex_generate_image` needs no image API key — your
existing `codex login` is enough.

> **This runs code on your computer.** Anything that can call these tools can make Codex
> execute code as you, inside its sandbox. Read [SECURITY.md](SECURITY.md) before using it.

## Requirements

- Node.js 20 or newer
- [Codex CLI](https://github.com/openai/codex) installed and logged in
- Windows, macOS or Linux

## Install

New to this? Follow the **[step-by-step setup guide](SETUP.md)** instead, which covers
finding your paths, configuring each client, verifying it works, and troubleshooting.

```bash
npm install -g @openai/codex   # the Codex CLI itself
codex login                    # one time

git clone https://github.com/ossmalaysia/codex-local-mcp.git
cd codex-local-mcp
npm install
npm run build
```

## Connect it to a client

> Full walkthrough with per-OS paths and troubleshooting: **[SETUP.md](SETUP.md)**.

The default transport is **stdio**. The client launches the server as a child process.
For remote access through an HTTPS endpoint, use [Remote access with OAuth](#remote-access-with-oauth).

Use **absolute paths** for `command` and for `CODEX_BIN`. MCP clients launch servers with a
minimal environment in which bare `node` and `codex` may not resolve.

### Claude Desktop

Add to `claude_desktop_config.json`, then fully quit and reopen the app.

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

On Windows the values look like `C:/Program Files/nodejs/node.exe` and
`C:/Users/you/AppData/Roaming/npm/codex.cmd`. Forward slashes work fine.

Find the right paths with `which node` / `which codex` (macOS, Linux) or
`(Get-Command node).Source` / `(Get-Command codex).Source` (PowerShell).

### Claude Code

```bash
claude mcp add codex -s user -- node /absolute/path/to/codex-local-mcp/dist/index.js
```

### Anything else

Any MCP client that can launch a stdio server works. Point it at
`node /absolute/path/to/dist/index.js`.

## Remote access with OAuth

HTTP mode exposes `/mcp` through Streamable HTTP. It includes browser login, OAuth discovery,
dynamic client registration, and authorization codes with PKCE S256.

This mode serves one trusted owner. All authorized clients share the local Codex account,
jobs, artifacts, and workspace root. It does not provide separate accounts or workspace isolation between clients.

First, run `codex login` on the server machine. Use the same operating system account that starts this server.
The server checks `codex login status` at startup and before MCP requests, with a 30-second success cache.
This checks local login status. It does not verify subscription limits or make a live OpenAI request.

### Built-in Cloudflare Tunnel

Install `cloudflared` first. Then run:

```bash
npm run build
npm run start:tunnel
```

The command requests an administrator username and password if `CODEX_MCP_PASSWORD` is not set.
Password input is hidden. These credentials stay in memory for the current server session.
Use at least 24 characters for the password.
Codex keeps its existing local login. You do not enter your OpenAI password into the MCP login page.

The server starts a Cloudflare Quick Tunnel and prints its public `/mcp` URL.
It also prints the exact `claude mcp add` command.
OAuth discovery and callbacks use the generated public address automatically.
No Cloudflare account or domain is required.

Keep the terminal open while you use remote MCP. Press Ctrl+C to stop the server and tunnel.
If the connector stops unexpectedly, the server closes its listener.
The next start creates a new public hostname and requires a new client login.

Quick Tunnels are for testing and development. They do not support SSE.
This server uses JSON responses with Streamable HTTP.
For a stable hostname, configure a named tunnel separately and use the manual setup below.
See [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

For unattended startup, set `CODEX_MCP_USERNAME` and `CODEX_MCP_PASSWORD` before running the command.
Alternatively, set `CODEX_MCP_TUNNEL=quick` and run `npm start` with those credentials configured.
If executable discovery fails, set `CLOUDFLARED_BIN` to the absolute `cloudflared` executable path.
The built-in tunnel requires a loopback listener. It uses a temporary empty connector configuration.
It does not modify your existing Cloudflare configuration or forward application credentials to the connector.

### Manual HTTPS setup

Set these variables in PowerShell:

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

Use a unique password with at least 24 characters. Passwords cannot exceed 1024 UTF-8 bytes.
On macOS or Linux, set the same environment variables before running `npm start`.

The listener defaults to `127.0.0.1:3000`. Put an HTTPS reverse proxy or tunnel in front of this listener.
Forward the entire public origin, including `/authorize`, `/login`, `/register`, `/token`, `/revoke`, and `/.well-known/*`.
Use an HTTPS origin without a path for `CODEX_MCP_PUBLIC_URL`.
Manual mode uses your existing HTTPS proxy or tunnel.

For example, Caddy can terminate HTTPS for your configured domain:

```caddyfile
codex.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Connect Claude Code to the public endpoint:

```bash
claude mcp add --transport http codex-remote https://codex.example.com/mcp
```

Run `/mcp` in Claude Code. Select the server and complete its browser login.
Enter the administrator username and password to approve access.
For an online session, configure the same public URL in a client that supports remote MCP with OAuth.
See [Claude Code remote MCP documentation](https://code.claude.com/docs/en/mcp).

Remote OAuth credentials and OpenAI credentials have separate purposes.
The administrator login approves MCP access. Codex uses its existing local login for task execution.
The server never forwards OpenAI tokens to MCP clients.
See [Codex authentication](https://learn.chatgpt.com/docs/auth?surface=cli).

Access tokens expire after 15 minutes. Refresh tokens rotate and expire 24 hours after initial approval.
Refresh token reuse or token revocation invalidates the entire token family.
OAuth state is held in memory. Restarting the server requires clients to register and sign in again.

Login permits 10 attempts per client IP every 15 minutes.
Proxy addresses are not trusted, so clients behind one proxy share this limit.
Cross-origin browser requests to `/mcp` are refused. Server-side MCP clients do not need browser CORS access.

| Variable | Default | Purpose |
|---|---|---|
| `CODEX_MCP_TRANSPORT` | `stdio` | Set `http` for remote access. |
| `CODEX_MCP_PUBLIC_URL` | `http://127.0.0.1:3000` | Public HTTPS origin. Loopback HTTP is allowed for local tests. |
| `CODEX_MCP_HOST` | `127.0.0.1` | Local listener address. |
| `CODEX_MCP_PORT` | `3000` | Local listener port. |
| `CODEX_MCP_USERNAME` | `admin` | Administrator login name. |
| `CODEX_MCP_PASSWORD` | *(required in HTTP mode)* | Administrator password. It is excluded from Codex subprocess environments. |
| `CODEX_MCP_TUNNEL` | *(disabled)* | Set `quick` to activate a Cloudflare Quick Tunnel with HTTP mode. |
| `CLOUDFLARED_BIN` | *(executable discovery)* | Absolute connector executable path. |

## Tools

| Tool | Arguments | Description |
|---|---|---|
| `codex_run` | `prompt`, `workspace?`, `timeout_sec?`, `model?`, `wait_sec?` | Run any task. |
| `codex_generate_image` | `prompt`, `count?`, `size?`, `quality?`, `workspace?`, `open?`, `wait_sec?` | Generate images. The prompt is passed through as written. |
| `codex_job_result` | `job_id`, `wait_sec?` | Collect the result of a task that was still running. |
| `codex_read_artifact` | `path`, `max_bytes?` | Read a file from a workspace. |

Reuse the same `workspace` name across calls to keep working on the same files.

### Images in the chat (experimental, opt-in)

Set `CODEX_MCP_APP_VIEW=true` and, in clients that support
[MCP Apps](https://modelcontextprotocol.io/extensions/apps), `codex_generate_image` renders an
image card **inside the chat**. While
Codex is still working the card shows progress, and it collects the finished image itself, so the
picture appears even if the model never polls. The card shows a preview; the full-resolution file
is in the workspace and opens in your default viewer.

Clients without MCP Apps support ignore the card and get the same text, image and link results
as before.

It is **off by default**. In Claude Desktop chats that reach this server through the desktop
app's device connection, declaring the card stopped image calls from arriving at all: they timed
out after four minutes with nothing logged by the server, while the same request without the card
worked. Until that is resolved, only enable it in a client you have tested it with.

### Long-running tasks

MCP clients built on the official SDK give up on a request after 60 seconds by default, and
image generation often takes longer. So a call waits up to `wait_sec` (default 45, maximum 50)
for Codex. If Codex has finished, you get the result as usual. If not, the call returns at once
with:

```
status: running
job_id: a3b1d698-5754-490c-ab5d-bc1ea76149a2
workspace: /path/to/codex-workspaces/my-task
```

Codex keeps working. Call `codex_job_result` with the `job_id` to collect the result; each
call waits up to `wait_sec` again, so poll until it finishes. Finished results stay available
for an hour. Jobs are held in memory, so a server restart loses the `job_id`, but any files
produced are still in the workspace shown.

`codex_generate_image` defaults to `quality: "low"` and `size: "1024x1024"` — a fast draft.
`size` must be `WIDTHxHEIGHT` or `auto`; a malformed value is rejected before Codex runs. The
size is a request to Codex rather than something the server can enforce, so the result
reports each image's actual dimensions and flags any that differ from what was asked.
Raise `quality` to `high` for final assets. `open` defaults to `true` and opens each image in
your default viewer, because MCP clients deliver tool-result images to the *model's* context
and do not render them into the chat for you.

## Configuration

All optional, set through the client's `env` block.

| Variable | Default | Purpose |
|---|---|---|
| `CODEX_MCP_ROOT` | `~/.codex-mcp/workspaces` | Root for all workspaces. Nothing is written outside it. |
| `CODEX_BIN` | `codex` | Absolute path to the Codex CLI. |
| `CODEX_MODEL` | *(Codex default)* | Model override. |
| `CODEX_TIMEOUT_SEC` | `300` | Default timeout before a run is killed. |
| `CODEX_MAX_TIMEOUT_SEC` | `1800` | Ceiling a caller may request. |
| `CODEX_MAX_OUTPUT_CHARS` | `40000` | Output cap; the head and tail are kept. |
| `CODEX_MAX_INLINE_IMAGE_BYTES` | `1048576` | Above this, a downscaled preview is inlined instead. |
| `CODEX_MAX_REPORTED_FILES` | `200` | Cap on reported changed files. |
| `CODEX_NETWORK_ACCESS` | `true` | Set `false` to deny Codex the network. |
| `CODEX_WAIT_SEC` | `45` | How long a call waits before returning a `job_id`. Capped at 50. |
| `CODEX_MAX_RUNNING_JOBS` | `4` | How many Codex jobs may run at once. |
| `CODEX_JOB_RETENTION_SEC` | `3600` | How long a finished job's result stays retrievable. |
| `CODEX_MCP_APP_VIEW` | `false` | Show generated images in the chat as an MCP App card. Experimental; see above. |

## How it works

Codex runs as `--sandbox workspace-write`: it can read and write **only inside the workspace
folder**, plus reach the network. Workspace names that would escape the root are refused.

A few decisions worth knowing about:

- **Artifacts are found by filesystem diff.** The workspace is snapshotted (path → mtime+size)
  before and after each run, so whatever Codex does, new files are detected. No output parsing.
- **The prompt travels on stdin** (`codex exec ... -`), so prompt text is never shell-quoted
  and cannot break out into the command line.
- **Budgets are counted in base64 characters, not file bytes.** Encoding inflates data by 4/3,
  so a budget expressed in file bytes overshoots what the client actually receives by a third.
  Images are downscaled until their *encoded* form fits, and a per-response budget caps all of
  them together. Originals on disk are never modified.
- **Full-resolution files are linked, not embedded.** Every reported file also comes back as an
  MCP `resource_link`. The server declares the `resources` capability and serves workspace
  files through `resources/read`, so a client can fetch the original on demand instead of
  having megabytes pushed into every response. Reads outside the workspace root are refused.
- **Generated images open in the OS viewer**, since clients don't render tool-result images.
- **Timeouts kill the whole process tree**, so a stuck build leaves no orphans.

## Development

```bash
npm test          # runs against a fake Codex - no CLI or API key needed
npm run build
```

See [CLAUDE.md](CLAUDE.md) for architecture and the invariants to preserve, and
[CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

CI runs the build, the test suite and `npm audit` on Ubuntu, Windows and macOS against
Node 20 and 22, plus weekly CodeQL analysis.

## Versioning

This project follows [Semantic Versioning](https://semver.org/). Releases are cut automatically
from [Conventional Commits](https://www.conventionalcommits.org/) and published as tags with
release notes on the [Releases page](https://github.com/ossmalaysia/codex-local-mcp/releases).
To use a specific release, check out its tag:

```bash
git checkout v0.1.0   # or any later tag
```

While the major version is `0`, minor releases may still contain breaking changes, which are
always called out in the release notes.

## Security

Please read [SECURITY.md](SECURITY.md). Report vulnerabilities privately through GitHub's
**Security → Report a vulnerability**, not as a public issue.

## License

[MIT](LICENSE) © OSS Malaysia
