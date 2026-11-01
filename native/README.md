# Native Windows application

The Rust service implements MCP over stdio and loopback HTTP. It runs the native Codex CLI directly.
It does not delegate jobs or OAuth requests to Node.js.

The Windows desktop uses Rust and Tauri 2, with a bundled TypeScript interface.
The normal EXE installer remains a small C# program. It provides staged installation, rollback, shortcuts, and uninstall registration.
The desktop sends service credentials through redirected stdin. Production child processes receive an explicit environment allowlist.
Windows Job Objects terminate remaining descendants when their owner closes.

## Build and check

Use the pinned Rust toolchain and Node.js for the existing compatibility tests.

```powershell
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked --all-targets
cargo build --locked --bins --examples
npm run build
node scripts/export-native-contract.mjs --check
npx playwright install chromium
node scripts/test-native.mjs
cargo audit
```

`fake_codex` is a separate native test fixture. Never include it in a release package.
The integration test calls no AI model and uses no live account.
Test workspace folders remain in the temporary directory for diagnosis.

## Build a Windows installer

```powershell
node scripts/build-desktop-ui.mjs
cargo clippy --locked -p codex-mcp-desktop --all-targets -- -D warnings
./scripts/build-native-desktop.ps1 -Version 0.7.1
./scripts/test-windows-setup.ps1 -Version 0.7.1
node scripts/test-native-desktop.mjs clean
```

This produces a normal per-user setup EXE under `artifacts`. No file copying is required from the user.
The manifest records `service: rust` and `desktop: tauri`.
The installer includes a Microsoft-signed WebView2 bootstrapper, used only when the runtime is missing.
OpenAI login, DPAPI passwords, Cloudflare credentials, and owned custom hostnames use the existing data directory.

The clean setup and native ZIP contain no Node.js, Sharp, or JavaScript MCP server.
The standard ZIP is a one-time compatibility bridge for installed C# updaters, which require legacy files.
On first launch, the Rust app removes unchanged bridge files using an exact SHA256 inventory.
Modified or unrelated files remain. Previous installation backups can retain old runtime files for recovery.
Use `build-windows.ps1` only for legacy compatibility packages and tests.
The optional MCP App view fails explicitly in Rust mode. Use the TypeScript service when that option is required.
The obsolete `execution.taskSupport: forbidden` tool hint is omitted by rmcp 3. Tool names, descriptions, and input schemas remain checked.
Artifact reads currently support Windows and Linux. macOS needs an opened-handle path implementation before native support is advertised.

## Signed updates

The desktop checks the fixed GitHub repository at startup and every 12 hours. The tray menu supports manual checks.
A notice and an install button appear when a newer stable version is available.
The app verifies Minisign metadata with its pinned public key, then checks the downloaded installer's signed size and SHA256.
The user selects Install in the normal setup window. Settings and workspaces remain in place.
Updates reject altered metadata, foreign URLs, wrong products, wrong architectures, and older versions.
The initial compatibility update uses the installed C# updater's existing GitHub digest checks. Later updates use the pinned key.
Update signing is separate from Windows Authenticode. The project does not have a Windows publisher certificate.

Release maintainers create a private key once with `codex-mcp-release keygen native/platform/update-public-key.txt`.
The local key is DPAPI protected. `codex-mcp-release github-secret` supplies it to the repository through stdin.
The release workflow signs metadata using the protected `WINDOWS_UPDATE_SIGNING_KEY` secret.
The workflow publishes a draft only after the installer and all update assets pass validation.

## Direct service use

The existing `CODEX_*` configuration names remain supported.
On Windows, `CODEX_BIN` must resolve to a native `.exe`. Shell launchers are deliberately refused.
HTTP requires a loopback listener, a configured public origin, and a saved MCP login.
Only public OAuth clients with `token_endpoint_auth_method: none` are accepted.
OpenAI login remains separate from MCP login.
The server validates Codex login at startup and caches successful request checks for 30 seconds.
OAuth state remains in memory. Restarting requires a fresh connector login.

```powershell
./target/release/codex-mcp-service.exe --http
./target/release/codex-mcp-service.exe --tunnel --managed --secrets-stdin
./target/release/codex-mcp-service.exe --sandbox-probe
```

Managed secret input is one bounded JSON line with `password` and `tunnelToken` fields.
Subsequent input accepts `stop`; EOF also stops the managed service.
Do not type or log real credentials in a shell command. The desktop manager supplies this private input.
Isolated HTTP startup runs the real sandbox probe before opening remote access.
The probe uses no AI model. Failure blocks startup.

## Release gates and remaining stages

The local native tests cover the protocol contract, detached jobs, artifact reads, images, browser login, PKCE, and refresh-family revocation.
They also check invalid paths, byte limits, child environment secrets, output bounds, and activity privacy.
Run real sandbox probes and installer lifecycle tests on each supported Windows backend before a stable native release.
Test a real Claude connector through Cloudflare before switching the default release channel.

The Tauri interface, signed-update trust transition, persistent OAuth sessions, and final Node removal are separate migration stages.
The existing updater remains unchanged. It still trusts GitHub TLS and release digests without an independent publisher signature.
The image decoder currently runs on bounded blocking workers within the service process. It is not a separate restricted process.
The child starts before Job Object assignment. A suspended process launch is a further hardening task.
Neither Job Objects nor Rust replace the Codex execution sandbox.

See [the migration design](../docs/RUST-MIGRATION.md) for the target architecture, acceptance measurements, and security boundaries.

## Task settings and live progress (0.7.1)

Open **Workspace → Task and image settings**. Save, then restart the connection to apply new defaults.
Claude can override these defaults through MCP parameters:

| Parameter | Default | Purpose |
| --- | --- | --- |
| `model` | Codex default | Select a supported Codex model. |
| `reasoning_effort` | `default` | Select model effort; support depends on the model. |
| `timeout_sec` | `300` | Limit task execution to 1–1800 seconds. |
| `count` | `1` | Request 1–10 images. |
| `size` | `1024x1024` | Bound image dimensions, or use `auto`. |
| `quality` | `low` | Request image generation quality. |
| `output_format` | `jpeg` | Save JPEG, PNG, or WebP. |
| `output_compression` | `80` | JPEG quality, 1–100. Native PNG and WebP saves are lossless. |
| `background` | `opaque` | Request an opaque, transparent, or automatic background. JPEG cannot preserve transparency. |
| `target_file_kb` | `256` | Prefer this file size. JPEG quality can decrease to 35 to approach it. |

Dimensions preserve aspect ratio and never enlarge the source. Actual dimensions and bytes appear in the result and desktop activity.
A file-size target is not a guarantee. The service does not reduce dimensions merely to reach a byte target.
Image generation quality and background are prompt requests, subject to the image tool's support.

The native service reads structured `codex exec --json` events. Activity shows stage history, elapsed time, event count, last-event age, selected settings, token usage, and output metadata.
The five-second heartbeat does not count as a new Codex event. No invented percentage is shown.
Commands, prompts, credentials, Base64, and task text do not enter desktop activity.

After an image task exits, the service collects only that CLI thread's generated-image cache.
It validates the thread UUID, confines opened cache files, applies decoder limits, and saves converted files in a fresh workspace output directory.
The sandbox still cannot read the private Codex home. Original cached images remain unchanged.
This avoids Base64 round trips through model text, patch events, and repeated PowerShell launches.

A local MXC test saved a 512×512 JPEG at 15,120 bytes in 43.5 seconds.
An earlier test using a Base64 patch transfer took 100.8 seconds. These are individual runs, not a general latency guarantee.
