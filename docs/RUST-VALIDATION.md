# Native service preview validation

Date: 2026-11-01. Platform: Windows x64. Preview package version: 0.6.0.
This is the first migration stage. It is not a stable-channel release.

## Passed checks

- Rust formatting and Clippy with warnings treated as errors.
- Nine Rust unit tests.
- Linux target compilation and Clippy from the Windows host. Linux execution remains a CI check.
- The existing TypeScript suite: 96 passed and three skipped.
- The exported MCP tool and resource contract check.
- Real native service tests with an independent TypeScript MCP client over stdio and HTTP.
- Detached jobs, polling, output bounds, failure reporting, execution timeout, and artifact retrieval.
- Image generation fixture output, inline image content, and original resource links.
- Invalid tool input, path traversal, Windows special path rejection, and file size limits.
- Private activity markers and exclusion of prompts and passwords from activity events.
- Native child rejection when MCP passwords or tunnel credentials enter its environment.
- Managed startup with credentials supplied through stdin, including a Unicode password.
- Chromium password retry, browser Origin, callback CSP, no callback referrer leak, and PKCE.
- Independent request cookies, authorization code reuse denial, wrong verifier, wrong resource, and wrong callback denial.
- Refresh-token rotation and revocation of all family access tokens after refresh reuse.
- The same browser and MCP checks through a real temporary Cloudflare HTTPS tunnel.
- A real MXC sandbox probe using the installed Codex executable, without a model call.
- The sandbox probe confirmed workspace access and denied private reads, outside reads, outside writes, and network access.
- Normal setup installation, manager UI, saved account state, live activity, installed native version, and protocol verification.
- Setup removal preserved settings and an unrelated user file.
- Cargo audit reported no known vulnerabilities across 199 locked dependencies.
- Production npm audit reported no vulnerabilities during packaging.

The latest complete setup test installed the preview in 8.72 seconds.
Tests used an isolated installation target. They did not replace the user's installed application.
The Cloudflare test used temporary credentials and a separate quick tunnel. It did not change the saved custom domain.

## Local startup measurement

Method: 20 fresh processes per implementation, including MCP initialization and tools/list.
The benchmark retained filesystem caches and called no model. Node version: 24.22.2.

| Implementation | Median | p95 |
| --- | ---: | ---: |
| TypeScript service | 704.51 ms | 724.76 ms |
| Rust release service | 219.27 ms | 360.57 ms |

These are one-machine observations. Background load and Windows executable scanning can affect the results.
An earlier run had a slower Rust p95. The native runtime now limits worker and blocking thread creation.
Do not treat these measurements as a remote generation speed claim or a general performance guarantee.
Use `scripts/benchmark-native.mjs` to repeat the measurement.

## Remaining release gates

The user's existing Claude connector was not changed during this preview test.
An actual Claude session, the elevated sandbox backend, and Windows machines without the same runtime state need release validation.
The C# interface, existing update trust, Node fallback package files, and in-process image worker remain in this stage.
Tauri, independent signed updates, final Node removal, and persistent OAuth sessions are not included.
See [native implementation status](../native/README.md) for the supported options and remaining boundaries.
