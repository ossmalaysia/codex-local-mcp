# Contributing

Thanks for your interest. This is a small, focused project — a thin, reliable bridge between
MCP clients and the Codex CLI. Contributions that keep it thin are the most welcome.

## Getting set up

```bash
git clone https://github.com/ossmalaysia/codex-local-mcp.git
cd codex-local-mcp
npm install
npm run build
npm test
```

The test suite runs against a **fake Codex**, so you do not need the Codex CLI installed or
any API key to develop. See [SETUP.md](SETUP.md) if you want to run it against the real CLI.

## Before you open a pull request

```bash
npm run build     # must compile with no errors
npm test          # all tests must pass
npm audit         # no moderate or worse vulnerabilities
```

CI runs these on Ubuntu, Windows and macOS against Node 20 and 22. **Windows is not
optional** — the process spawning, argument quoting and process-tree termination in
`src/codex.ts` are platform-specific and have all broken there before.

## What makes a good change

- **Fix a bug you can demonstrate.** Add a test that fails before your fix and passes after.
- **Keep modules single-purpose.** Each file in `src/` does one job; see the table in
  [CLAUDE.md](CLAUDE.md). If a change makes a file do two things, it probably wants a new file.
- **Preserve the invariants.** [CLAUDE.md](CLAUDE.md) lists them. They are also security
  properties described in [SECURITY.md](SECURITY.md). Changing one needs a matching test and a
  clear explanation.
- **Explain *why* in comments**, particularly for platform workarounds. Several of them look
  removable and are not — that is exactly why the comments are there.
- **Be cautious with new runtime dependencies.** This server runs on people's machines with
  the ability to execute code. Every dependency is added surface area. Dev dependencies are a
  much easier sell.

## What is likely to be declined

- An HTTP or network transport. This server is deliberately stdio-only; exposing it to a
  network publishes remote code execution. See [SECURITY.md](SECURITY.md).
- Parsing Codex's output text to detect artifacts. Artifacts are found by filesystem diff
  precisely because Codex's output format is not a contract.
- Elaborate prompt templating. Codex is an agent that already knows how to work; over-scripting
  its prompt has measurably made it take worse paths.

## Reporting bugs

Open an issue with your OS, Node version, Codex CLI version, the relevant part of your client
config with paths and secrets redacted, and what you saw versus what you expected. The log
locations and useful log lines are listed in [SETUP.md](SETUP.md#troubleshooting).

**For security vulnerabilities, do not open a public issue.** Follow
[SECURITY.md](SECURITY.md) and use GitHub's private vulnerability reporting.

## Code of conduct

Be decent to each other. Assume good faith, keep criticism about the code, and accept that
maintainers may say no to keep the project small.

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
