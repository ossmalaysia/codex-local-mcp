# Native Windows validation

Date: 2026-11-01. Platform: Windows x64. Native desktop package version: 0.7.0.

## Desktop and update transition

- The Rust/Tauri desktop compiles with strict TypeScript checks and Clippy warnings treated as errors.
- Nineteen Rust tests cover the service, DPAPI compatibility, saved C# Cloudflare settings, bounded child output, migration paths, and signed updates.
- Signature tests reject changed metadata, another signing key, older versions, unexpected versions, and foreign installer URLs.
- Chromium checks cover saved account details, saved passwords, saved hostnames, live activity, update notices, errors, and minimum window width.
- The actual packaged WebView2 app passed account status, password generation, encrypted settings, restricted IPC, and an MXC sandbox check.
- The normal setup installed in an isolated target in 7.54 seconds with WebView2 already present.
- Setup checked application and Installed apps versions. Uninstall preserved settings and an unrelated file.
- The user's installed 0.5.0 updater verified and swapped the 0.7.0 compatibility ZIP in a separate test folder.
- The upgraded Rust app then removed the unchanged Node runtime and passed the actual WebView2 and MXC checks.
- The clean installer contains no Node runtime, Sharp, or TypeScript MCP server.
- Pinned Codex 0.166.0 uses its native code-mode host with an embedded V8 runtime. The native host remains bundled.
- npm audit found no vulnerabilities. Cargo audit found no vulnerability advisories after an unused ZIP dependency was removed.
- Cargo audit reports maintenance warnings and a GLib warning in dependencies for unsupported Linux desktop builds. Windows does not build GLib.

The application update key is pinned in source. Its local private key uses DPAPI; the release workflow uses a GitHub Actions secret.
This is update-package signing, not Windows Authenticode publisher signing.
The clean installer embeds a Microsoft-signed WebView2 bootstrapper. The missing-runtime installation branch was inspected, not tested on a clean Windows image.
Local Linux cross-compilation of the new desktop support library lacks a Linux C compiler. Native Linux service checks remain in CI.
No model generation call was used for the migration tests.

## Service checks retained from the first stage

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

## Runtime boundaries

The user's running Claude connector was not replaced during isolated desktop tests.
Restarting the service clears in-memory OAuth grants. Reconnect the Claude connector after the application update.
The alternate restricted-token sandbox remains dependent on the Windows device policy. The local desktop test used MXC.
Image decoding uses a bounded worker thread in the service. It is not a separate sandbox process.
The optional MCP App view is not supported by the Rust service. Standard image content and resource links are supported.
See [native implementation status](../native/README.md) for the supported options and remaining boundaries.
