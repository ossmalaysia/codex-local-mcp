# Native service: first migration stage

The Rust service implements MCP over stdio and loopback HTTP. It runs the native Codex CLI directly.
It does not delegate jobs or OAuth requests to Node.js.

The Windows package can select this service while keeping the existing C# manager, Cloudflare setup, tray, and EXE installer.
The manager sends credentials through redirected stdin. Production child processes receive an explicit environment allowlist.
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

## Build a Windows preview installer

```powershell
./scripts/build-windows.ps1 -Version 0.6.0 -NativeService
./scripts/test-windows-setup.ps1 -Version 0.6.0
```

This produces a normal per-user setup EXE under `artifacts`.
The manager selects Rust when `runtime/codex-mcp-service.exe` exists.
The manifest records `service: rust`. The native executable reports the package version supplied by the build script.
Both the setup test and installed verification check the native executable.

The default package build still selects TypeScript. Do not reuse a native payload directory for a TypeScript-only build.
The preview retains Node.js, Sharp, and the TypeScript fallback files for compatibility and verification.
It therefore does not yet reduce the total package size. Removing those files requires a separate packaging transition.
The optional MCP App view fails explicitly in Rust mode. Use the TypeScript service when that option is required.
The obsolete `execution.taskSupport: forbidden` tool hint is omitted by rmcp 3. Tool names, descriptions, and input schemas remain checked.
Artifact reads currently support Windows and Linux. macOS needs an opened-handle path implementation before native support is advertised.

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
