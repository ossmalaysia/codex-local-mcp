# codex-local-mcp

An MCP server that lets an LLM drive the local Codex CLI. Node 20+, TypeScript, ESM,
stdio transport only.

## Commands

```bash
npm install
npm run build     # tsc -> dist/
npm test          # vitest, 11 tests, no Codex CLI or API key required
npm run dev       # tsc --watch
```

Tests run against a **fake Codex** (`test/fake-codex.mjs`) wrapped in a platform-native shim,
so the suite is hermetic. Never make a test depend on the real CLI.

## Architecture

One job per module. Keep it that way.

| File | Responsibility |
|---|---|
| `src/index.ts` | MCP wiring and tool schemas only. No business logic. |
| `src/codex.ts` | Spawning `codex exec`, timeout, process-tree kill, output capping. |
| `src/workspace.ts` | Workspace resolution (escape-proof) and before/after snapshots. |
| `src/artifacts.ts` | Classifying changed files, inlining images, reading one artifact. |
| `src/preview.ts` | Downscaling oversized images with sharp. |
| `src/open.ts` | Opening a file in the OS viewer. |
| `src/task.ts` | Orchestration: prepare, snapshot, run, diff, report. |
| `src/config.ts` | Environment configuration, read once at import. |

Flow: resolve workspace → snapshot → spawn codex → snapshot → diff → report.

## Invariants

Changing any of these needs a matching test. They are also security properties, documented
in `SECURITY.md`.

- **stdout is the MCP transport.** All human-facing logging goes to `console.error`. A stray
  `console.log` corrupts the protocol stream.
- **The prompt is passed on stdin**, never as a command-line argument. This is what keeps
  prompt text out of the shell.
- **Workspace paths that escape `CODEX_MCP_ROOT` are refused, not clamped.** Same for
  `readArtifact`.
- **Artifacts are discovered by filesystem diff**, not by parsing Codex's output. Do not add
  output parsing; it is brittle and Codex's format is not a contract.
- **Every tool returns a readable error result**, never an unhandled rejection.
- **Inline budgets are measured in base64 characters, never file bytes.** A raw-byte budget
  understates the payload by a third and lets an image just under the limit produce a larger
  response than one far over it. There is a per-image budget and a per-response total.
- **Anything not inlined is still reachable**, via a `resource_link` plus `resources/read`,
  and carries a note explaining why it was not inlined. Nothing is dropped silently.
- **Never check a path and then re-open that path.** Use `openConfined()`, which validates,
  opens once without following links, verifies the opened file's identity, and hands back a
  handle. Reading by name after checking by name is a race: the name can be repointed in
  between. This applies to previews too, which take bytes rather than a path.
- **Confinement is checked against resolved paths, not lexical ones.** `assertInsideRoot()`
  uses `realpath`, because a symlink or Windows junction inside the root passes a lexical
  check and still points outside.
- **Never let a relative entry onto the child's PATH, and never run the CLI with a task
  workspace as the working directory.** Windows resolves executables against the working
  directory, and Codex can write to its workspace, so either mistake lets a dropped
  `codex.cmd` run outside the sandbox. `CODEX_BIN` is resolved absolutely at startup.
- **Every spawned helper needs an `error` listener.** `try/catch` does not catch a child
  process's asynchronous launch failure, and an unhandled one terminates the server.
- **Resource reads honour the same root confinement as the tools.** `resources/read` goes
  through `readArtifact`, so a path outside `CODEX_MCP_ROOT` is refused.

## Windows specifics

This project is developed on Windows and these were all real bugs. Do not "simplify" them.

- Do **not** use `shell: true`. MCP clients launch servers with a minimal environment where
  Node cannot resolve `cmd.exe`, giving `spawn cmd.exe ENOENT`. Resolve the interpreter
  absolutely via `ComSpec`/`SystemRoot`.
- Quote arguments yourself. Node does not quote for the shell, and paths containing spaces
  (`C:\Users\First Last\...`) silently split into two arguments.
- Wrap the whole `cmd /d /s /c` command line in outer quotes. With `/s`, cmd strips the first
  and last quote of the line, which otherwise corrupts a later argument.
- The child needs an augmented `PATH`: `codex.cmd` re-invokes `node`.
- Killing a timed-out run needs `taskkill /T /F`; Node cannot kill a process tree on Windows.

## Conventions

- Comments explain *why*, especially for the platform workarounds above. Do not remove them.
- Size control belongs in this server, not in the prompt. Codex's built-in `image_gen` tool
  does not accept `quality` or `output_format` as arguments (those are fallback-CLI-only
  controls), and gpt-image-2 requires at least 655,360 pixels per image, so a generated PNG is
  essentially always too large to inline untouched. Enforce limits in code.
- Prompts sent to Codex are pass-through. Codex is an agent that already knows how to work;
  over-scripting its prompt causes it to take worse paths (an early version instructed it to
  call an image API, which made it ignore its own native image tool).
- No new runtime dependencies without a reason that a reviewer would agree with.
