# Security Policy

## What this software does

`codex-local-mcp` is an MCP server that lets an LLM run the Codex CLI on your machine.
Codex writes and executes code. **Any client that can call these tools can cause arbitrary
code to run on the host, as the user who started the server.**

Read that sentence again before deploying this anywhere other than your own computer.

## Threat model

### In scope

The server is designed to hold these properties. A reproducible failure of any of them is a
vulnerability; please report it.

| Property | How it is enforced |
|---|---|
| Codex cannot read or write outside the workspace root | `codex exec --sandbox workspace-write`, with `--cd` inside `CODEX_MCP_ROOT` |
| A caller cannot escape the workspace root via the `workspace` argument | `resolveWorkspace()` refuses absolute paths and any path resolving outside the root |
| Symlinks and Windows junctions cannot be used to escape the root | `assertInsideRoot()` resolves links with `realpath` and checks the real target, on workspace creation, artifact collection and every read |
| A caller cannot read arbitrary files via `codex_read_artifact` or `resources/read` | Both go through `readArtifact()`, which refuses any path resolving outside the root |
| The Codex executable cannot be substituted by workspace contents | `CODEX_BIN` is resolved to an absolute path at startup, relative entries are stripped from the child `PATH`, and the child's working directory is the root rather than the task workspace |
| A failed helper process cannot take down the server | `taskkill` and the image viewer both handle the asynchronous `error` event |
| Runaway output cannot exhaust server memory | Both streams are buffered head-and-tail with a fixed budget while draining |
| Prompt text cannot break out into the host shell | The prompt is passed to Codex on **stdin**, never as a command-line argument |
| A hung or runaway Codex run cannot persist | Timeout kills the whole process tree (`taskkill /T` on Windows, process group kill elsewhere) |
| Tool output cannot exhaust the caller's context | Output is capped; oversized images are downscaled into previews |

### Out of scope

These are inherent to what the tool is, not bugs:

- **Codex executes code inside the workspace.** That is the entire purpose. Scripts it writes
  can consume CPU, disk and network within the sandbox.
- **Network access is enabled by default** (`CODEX_NETWORK_ACCESS=true`), because image
  generation and package installation need it. Code Codex runs can therefore make outbound
  requests. Set `CODEX_NETWORK_ACCESS=false` to deny this.
- **Prompt injection.** If you ask Codex to process untrusted content (a downloaded page, a
  third-party repository), that content may influence what Codex does within its sandbox.
  Treat any workspace that has touched untrusted input as untrusted.
- **The sandbox is the Codex CLI's sandbox.** This project configures it; it does not
  implement it. Sandbox escapes belong to the upstream Codex CLI.
- **Secrets in the environment are visible to Codex.** Anything you put in the server's `env`
  (for example `OPENAI_API_KEY`) is inherited by the code Codex runs. Pass only what is needed.

## Deployment guidance

- **Local stdio only.** This server speaks stdio and is intended to be launched as a child
  process by a local MCP client. It deliberately implements no HTTP transport.
- **Do not expose it to a network.** Putting a tunnel or HTTP bridge in front of it publishes
  remote code execution on your machine. If you must, require authentication and understand
  that you own the consequences.
- **Give it its own workspace root.** Point `CODEX_MCP_ROOT` at a dedicated directory, not at
  your source tree or home directory.
- **Prefer a machine you can rebuild.** For untrusted workloads, run it in a VM or container.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private vulnerability reporting on this repository:
**Security → Report a vulnerability**.

Include what you did, what happened, what you expected, and the smallest reproduction you
have. We aim to acknowledge within 7 days and to agree a disclosure timeline with you.

## Supported versions

This project is pre-1.0. Security fixes land on `main`; there are no backported release
branches.
