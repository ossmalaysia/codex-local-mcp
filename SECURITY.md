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
| A file cannot be swapped between the check and the read | `openConfined()` opens once with `O_NOFOLLOW` where supported and compares the opened file's device and inode with what was checked; all reads use that handle |
| Symlinks and Windows junctions cannot be used to escape the root | `assertInsideRoot()` resolves links with `realpath` and checks the real target, on workspace creation, artifact collection and every read |
| A caller cannot read arbitrary files via `codex_read_artifact` or `resources/read` | Both go through `readArtifact()`, which refuses any path resolving outside the root |
| The Codex executable cannot be substituted by workspace contents | `CODEX_BIN` is resolved to an absolute path at startup, relative entries are stripped from the child `PATH`, and the child's working directory is the root rather than the task workspace |
| A failed helper process cannot take down the server | `taskkill` and the image viewer both handle the asynchronous `error` event |
| Callers cannot start unbounded numbers of Codex processes | Tasks run as jobs that outlive their calls, so concurrent jobs are capped at `CODEX_MAX_RUNNING_JOBS` (default 4); further starts are refused |
| The in-chat image view cannot run code from a result | It inserts text with `textContent`, builds image sources only for PNG, JPEG, GIF and WebP data, loads nothing from the network, and runs in the host's sandbox; it can only call this server's own tools, which keep their confinement |
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

- **Stdio is the default.** HTTP mode requires an administrator password and OAuth authorization.
  Use an HTTPS reverse proxy for public access. See [remote setup](README.md#remote-access-with-oauth).
- **Remote access grants code execution.** Every authorized client uses the same local account,
  workspace root, artifacts, and jobs. This is a single-owner service, without tenant isolation.
- **OAuth protects every MCP request.** The server issues resource-bound access tokens after browser login
  and PKCE validation. Codes expire after 60 seconds and can be used once.
  Access tokens expire after 15 minutes. Refresh tokens rotate within a 24-hour authorization lifetime.
  Refresh token reuse and revocation invalidate all tokens in the same family.
- **Login approval requires browser binding.** Login forms expire after five minutes and require an HttpOnly,
  SameSite cookie. HTTPS origins use Secure cookies. Login attempts have a per-IP rate limit.
  The password is hashed with scrypt in memory and excluded from Codex subprocess environments.
- **Codex login stays local.** HTTP startup and MCP requests check CLI login status.
  Successful checks are cached for 30 seconds. This does not verify credentials with OpenAI.
- **Restart revokes remote access.** Clients, authorization codes, and tokens are held in bounded memory stores.
  Clients must register and sign in again after a restart.
- **Tunnel activation is explicit.** `npm run start:tunnel` or `CODEX_MCP_TUNNEL=quick` publishes the OAuth-protected service.
  The connector targets IPv4 loopback. Activation waits for a public URL and an established connection.
  The server closes its listener if the connector exits. Shutdown stops both processes.
  Connector processes receive only selected operating system and network environment settings.
  A temporary empty configuration prevents existing named tunnel settings from changing the destination.
- **Interactive login setup is session-only.** Password input is hidden and is not written to a credential file.
  Environment variables can provide credentials for unattended startup.
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

Only the **latest release** receives security fixes. Fixes are released as soon as they
merge, as a patch release, and are never backported to older versions. The project is pre-1.0,
so upgrade to the newest tag rather than pinning an old one.
