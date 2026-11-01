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
./scripts/build-native-desktop.ps1 -Version <version>
./scripts/test-windows-setup.ps1 -Version <version>
node scripts/test-native-desktop.mjs clean
```

Published installers are built by the release workflow from a clean checkout of the exact release tag.
After a UI change, refresh the screenshots in the [Windows app guide](../docs/WINDOWS-GUIDE.md) with
`node scripts/build-desktop-ui.mjs` and `node scripts/capture-guide-images.mjs`. They use a mock backend and example data.

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
OAuth sessions are saved to `oauth-sessions.json` in `CODEX_PRIVATE_ROOT`, so a restart or update keeps Claude signed in.
The file holds registered clients and SHA-256 token fingerprints, never tokens. Sandbox commands cannot read that directory.
A sign-in lasts 30 days, and refresh tokens rotate within it. A changed username, password, or public origin discards saved sessions.
Without `CODEX_PRIVATE_ROOT`, OAuth state stays in memory and a restart requires a fresh connector login.

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

## Upgrading from older installations

The setup EXE uses a separate application folder when an old MSI installation exists, and leaves the MSI registration intact.
The standard update ZIP is a one-time bridge for installed C# managers, which use their GitHub digest checks for that first upgrade.
Later updates use the pinned signing key.
Saved OpenAI sign-ins, encrypted passwords, Cloudflare credentials, custom hostnames, and workspaces remain available.

## Tests and known limits

The local native tests cover the protocol contract, detached jobs, parallel image runs, artifact reads, images, browser login, PKCE,
refresh-family revocation, and saved OAuth sessions.
They also check invalid paths, byte limits, child environment secrets, output bounds, and activity privacy.
Run real sandbox probes and installer lifecycle tests on each supported Windows backend before a stable release.

Known limits:

- The image decoder runs on bounded blocking workers inside the service process, not in a separate restricted process.
- The child process starts before Job Object assignment. A suspended process launch is a further hardening task.
- Neither Job Objects nor Rust replace the Codex execution sandbox.

See [the migration design](../docs/RUST-MIGRATION.md) for the architecture, acceptance measurements, and security boundaries,
and [the validation record](../docs/RUST-VALIDATION.md) for measured results.

## Task settings and live progress

Open **Workspace → Task and image settings**. Save, then restart the connection to apply new defaults.
Claude can override these defaults through MCP parameters:

| Parameter | Default | Purpose |
| --- | --- | --- |
| `model` | Codex default | Select a supported Codex model. |
| `reasoning_effort` | `default` | Select model effort; support depends on the model. |
| `timeout_sec` | `300` | Limit task execution to 1–1800 seconds. |
| `count` | `1` | Request 1–10 images. Each image is a separate Codex run, and the runs work in parallel. |
| `size` | `1024x1024` | Bound image dimensions, or use `auto`. |
| `quality` | `low` | Request image generation quality. |
| `output_format` | `jpeg` | Save JPEG, PNG, or WebP. |
| `output_compression` | `80` | JPEG quality, 1–100. Native PNG and WebP saves are lossless. |
| `background` | `opaque` | Request an opaque, transparent, or automatic background. JPEG cannot preserve transparency. |
| `target_file_kb` | `256` | Prefer this file size. JPEG quality can decrease to 35 to approach it. |

Dimensions preserve aspect ratio and never enlarge the source. Actual dimensions and bytes appear in the result and desktop activity.
A file-size target is not a guarantee. The service does not reduce dimensions merely to reach a byte target.
Image generation quality and background are prompt requests, subject to the image tool's support.

Parallel image generation: a request with `count` above 1 starts one Codex run per image inside one job.
`CODEX_MAX_RUNNING_JOBS` (default 4) caps Codex processes as well as jobs, so other jobs wait for a free slot.
The job's `timeout_sec` is one deadline for all its runs. A run that waits for a slot receives only the time that remains.
If some runs fail, the result still contains the images that succeeded, lists the failures, and reports an error.
Separate requests also run in parallel when they use different workspaces. Requests for the same workspace run one at a time.
Each run consumes image-generation usage on the signed-in OpenAI account, so parallel runs can reach rate limits sooner.

The native service reads structured `codex exec --json` events. Activity shows stage history, elapsed time, event count, last-event age, selected settings, token usage, and output metadata.
The five-second heartbeat does not count as a new Codex event. No invented percentage is shown.
Commands, credentials, Base64, and task text do not enter desktop activity.
Prompts enter activity only when the user turns on the desktop setting, which sets `CODEX_MCP_ACTIVITY_PROMPTS=1`.
The service then sends the caller's prompt once, bounded to 2,000 characters and 8,000 escaped JSON bytes.

After an image task exits, the service collects only that CLI thread's generated-image cache.
It validates the thread UUID, confines opened cache files, applies decoder limits, and saves converted files in a fresh workspace output directory.
The sandbox still cannot read the private Codex home. Original cached images remain unchanged.
This avoids Base64 round trips through model text, patch events, and repeated PowerShell launches.

A local MXC test saved a 512×512 JPEG at 15,120 bytes in 43.5 seconds.
An earlier test using a Base64 patch transfer took 100.8 seconds. These are individual runs, not a general latency guarantee.
