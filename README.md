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

This is a **stdio** server: the client launches it as a child process. There is no URL and
nothing listens on a port.

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

## Tools

| Tool | Arguments | Description |
|---|---|---|
| `codex_run` | `prompt`, `workspace?`, `timeout_sec?`, `model?` | Run any task. Blocks until Codex finishes. |
| `codex_generate_image` | `prompt`, `count?`, `size?`, `quality?`, `workspace?`, `open?` | Generate images. The prompt is passed through as written. |
| `codex_read_artifact` | `path`, `max_bytes?` | Read a file from a workspace. |

Reuse the same `workspace` name across calls to keep working on the same files.

`codex_generate_image` defaults to `quality: "low"` and `size: "1024x1024"` — a fast draft.
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

## How it works

Codex runs as `--sandbox workspace-write`: it can read and write **only inside the workspace
folder**, plus reach the network. Workspace names that would escape the root are refused.

A few decisions worth knowing about:

- **Artifacts are found by filesystem diff.** The workspace is snapshotted (path → mtime+size)
  before and after each run, so whatever Codex does, new files are detected. No output parsing.
- **The prompt travels on stdin** (`codex exec ... -`), so prompt text is never shell-quoted
  and cannot break out into the command line.
- **Oversized images become previews.** A file over the inline budget is re-encoded smaller
  until it fits, so the model still sees it. The original on disk is never modified.
- **Generated images open in the OS viewer**, since clients don't render tool-result images.
- **Timeouts kill the whole process tree**, so a stuck build leaves no orphans.

## Development

```bash
npm test          # 11 tests against a fake Codex - no CLI or API key needed
npm run build
```

See [CLAUDE.md](CLAUDE.md) for architecture and the invariants to preserve.

## Security

Please read [SECURITY.md](SECURITY.md). Report vulnerabilities privately through GitHub's
**Security → Report a vulnerability**, not as a public issue.

## License

[MIT](LICENSE) © OSS Malaysia
