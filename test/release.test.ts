import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/**
 * Guards the release pipeline, which only runs after a merge to main.
 *
 * v0.2.0 failed to release because conventional-changelog-conventionalcommits
 * had moved to a major that needs a newer changelog writer than
 * @semantic-release/release-notes-generator bundles. Nothing caught it: a
 * semantic-release dry run on a branch with no releasable commits never renders
 * notes. These tests render notes and analyse commits with the real config, so
 * an incompatible dependency bump fails its own pull request instead.
 */

// semantic-release itself requires Node 22.14+; the release job runs on 22.
const [major, minor] = process.versions.node.split(".").map(Number);
const supported = major > 22 || (major === 22 && minor >= 14);

const require = createRequire(import.meta.url);

type PluginEntry = string | [string, Record<string, unknown>];

function pluginOptions(name: string): Record<string, unknown> {
  const config = JSON.parse(fs.readFileSync(".releaserc.json", "utf8")) as { plugins: PluginEntry[] };
  const entry = config.plugins.find((p) => (Array.isArray(p) ? p[0] : p) === name);
  if (!entry) throw new Error(`${name} is not configured in .releaserc.json`);
  return Array.isArray(entry) ? entry[1] : {};
}

async function load<T>(pkg: string): Promise<T> {
  return (await import(pathToFileURL(require.resolve(pkg)).href)) as T;
}

const logger = { log() {} };

describe.skipIf(!supported)("release tooling", () => {
  it("renders release notes for features and fixes", async () => {
    const { generateNotes } = await load<{
      generateNotes: (options: unknown, context: unknown) => Promise<string>;
    }>("@semantic-release/release-notes-generator");

    const notes = await generateNotes(pluginOptions("@semantic-release/release-notes-generator"), {
      cwd: process.cwd(),
      options: { repositoryUrl: "https://github.com/ossmalaysia/codex-local-mcp.git" },
      lastRelease: { gitTag: "v1.0.0", version: "1.0.0" },
      nextRelease: { gitTag: "v1.1.0", version: "1.1.0" },
      commits: [
        { message: "feat: add a thing", hash: "a".repeat(40) },
        { message: "fix(image): correct a thing", hash: "b".repeat(40) },
      ],
      logger,
    });

    expect(notes).toContain("### Features");
    expect(notes).toContain("add a thing");
    expect(notes).toContain("### Bug Fixes");
    expect(notes).toContain("**image:** correct a thing");
  });

  it("maps commit types to the documented version bumps", async () => {
    const { analyzeCommits } = await load<{
      analyzeCommits: (options: unknown, context: unknown) => Promise<string | null>;
    }>("@semantic-release/commit-analyzer");
    const options = pluginOptions("@semantic-release/commit-analyzer");

    const bump = (message: string) =>
      analyzeCommits(options, { commits: [{ message, hash: "c".repeat(40) }], logger });

    expect(await bump("fix: a")).toBe("patch");
    expect(await bump("perf: a")).toBe("patch");
    expect(await bump("fix(deps): bump a")).toBe("patch");
    expect(await bump("feat: a")).toBe("minor");
    expect(await bump("feat!: a")).toBe("major");
    expect(await bump("refactor: a\n\nBREAKING CHANGE: b")).toBe("major");
    expect(await bump("docs: a")).toBeNull();
    expect(await bump("chore(deps-dev): bump a")).toBeNull();
    expect(await bump("ci(deps): bump a")).toBeNull();
  });
});
