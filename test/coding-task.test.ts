import { describe, expect, it, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-expect-error - plain JS test helper
import { installFakeCodex, makeRoot } from "./setup-fake-codex.mjs";
import { resultText, useMcpClient, type ToolResult } from "./mcp-client.js";

/**
 * codex_task end to end, hermetically: a local bare repository stands in for
 * GitHub, a clone of it for the user's checkout, and the fake Codex edits the
 * worktree it is pointed at. No network and no real CLI.
 */
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mcp-git-"));
const origin = path.join(scratch, "origin.git");
const clone = path.join(scratch, "clone");
const gitId = ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "init.defaultBranch=main"];
const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", [...gitId, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

run(scratch, "init", "-q", "--bare", origin);
const seed = path.join(scratch, "seed");
run(scratch, "init", "-q", seed);
fs.writeFileSync(path.join(seed, "README.md"), "# Demo\n");
fs.writeFileSync(path.join(seed, ".gitignore"), "node_modules/\n");
// Tracked hooks, as husky sets up. The user's clone points core.hooksPath at
// them, so without protection checking out a fetched ref would run its code.
const marker = path.join(scratch, "hook-ran");
fs.mkdirSync(path.join(seed, ".hooks"));
for (const hook of ["post-checkout", "reference-transaction"]) {
  fs.writeFileSync(path.join(seed, ".hooks", hook), `#!/bin/sh\necho "$0" >> "${marker.replace(/\\/g, "/")}"\n`, { mode: 0o755 });
}
run(seed, "add", "-A");
run(seed, "update-index", "--chmod=+x", ".hooks/post-checkout", ".hooks/reference-transaction");
run(seed, "commit", "-q", "-m", "initial");
run(seed, "push", "-q", origin, "HEAD:refs/heads/main");
run(seed, "checkout", "-q", "-b", "feature");
fs.writeFileSync(path.join(seed, "feature.txt"), "on the feature branch\n");
run(seed, "add", "-A");
run(seed, "commit", "-q", "-m", "feature");
run(seed, "push", "-q", origin, "HEAD:refs/heads/feature");
run(scratch, "clone", "-q", origin, clone);
run(clone, "config", "core.hooksPath", ".hooks");
const featureSha = run(seed, "rev-parse", "HEAD").trim();

const root: string = makeRoot();
process.env.CODEX_MCP_ROOT = root;
process.env.CODEX_BIN = installFakeCodex();
process.env.CODEX_TIMEOUT_SEC = "30";
process.env.CODEX_MAX_PATCH_CHARS = "20000";
process.env.CODEX_PROJECTS = JSON.stringify({
  demo: { path: clone, setup: "npm ci", checks: { test: "npm test", lint: "npm run lint" } },
  plain: { path: clone },
});

const { call, client } = useMcpClient("coding-task-test");

function header(result: ToolResult, key: string): string {
  const match = new RegExp(`^${key}: (.*)$`, "m").exec(resultText(result));
  if (!match) throw new Error(`no ${key} in: ${resultText(result)}`);
  return match[1];
}

function section(result: ToolResult, name: string): string {
  const text = result.content[0].text ?? "";
  const start = text.indexOf(`--- ${name} ---\n`);
  if (start < 0) throw new Error(`no ${name} section in: ${text}`);
  const body = text.slice(start + name.length + 9);
  const next = body.search(/\n\n--- [a-z]+ ---\n/);
  return next < 0 ? body : body.slice(0, next);
}

/** A clean checkout of `base`, with `patch` applied by git itself. */
function applyOnCleanCheckout(base: string, patch: string): string {
  const dir = fs.mkdtempSync(path.join(scratch, "apply-"));
  run(scratch, "clone", "-q", origin, dir);
  run(dir, "checkout", "-q", "--detach", base);
  const file = path.join(scratch, `${path.basename(dir)}.patch`);
  fs.writeFileSync(file, patch);
  run(dir, "apply", "--binary", file);
  return dir;
}

function worktrees(): string {
  return run(clone, "worktree", "list", "--porcelain");
}

let projects: string;
beforeAll(async () => {
  projects = resultText(await call("codex_projects", {}));
});

describe("codex_projects", () => {
  it("lists names, checks and setup without revealing local paths", () => {
    expect(projects).toContain("project: demo");
    expect(projects).toContain("checks: lint, test");
    expect(projects).toContain("setup: defined");
    expect(projects).toContain("project: plain");
    expect(projects).toContain("setup: none");
    expect(projects).not.toContain(clone);
    expect(projects).not.toContain(scratch);
  });
});

describe("codex_task", () => {
  it("returns a patch that applies cleanly, including new untracked and binary files", async () => {
    const result = await call("codex_task", {
      project: "demo",
      ref: "feature",
      task: "EDIT_REPO please",
      acceptance: "tests pass",
      checks: ["test"],
      wait_sec: 30,
    });
    expect(result.isError).toBe(false);
    expect(header(result, "status")).toBe("completed");
    expect(header(result, "project")).toBe("demo");
    expect(header(result, "ref")).toBe("feature");
    expect(header(result, "base")).toBe(featureSha);
    expect(header(result, "exit code")).toBe("0");
    expect(section(result, "summary")).toContain("fake codex final message");
    expect(section(result, "summary")).toContain("sandbox: workspace-write");
    expect(section(result, "summary")).toMatch(/npm cache: .*\.cache.demo.npm/);
    expect(section(result, "summary")).toMatch(/writable roots: .*\.cache.demo/);
    expect(section(result, "diffstat")).toContain("README.md");
    expect(section(result, "checks")).toContain("- test: npm test");
    expect(section(result, "checks")).toContain("not independently verified");

    const applied = applyOnCleanCheckout(featureSha, section(result, "patch"));
    expect(fs.readFileSync(path.join(applied, "README.md"), "utf8")).toBe("# Demo\nEdited by fake codex.\n");
    expect(fs.readFileSync(path.join(applied, "src", "added.txt"), "utf8")).toBe("a new untracked file\n");
    expect(fs.readFileSync(path.join(applied, "output", "img.png")).subarray(1, 4).toString()).toBe("PNG");

    // The task reached Codex as written, with only the documented additions.
    const notes = fs.readFileSync(path.join(applied, "notes.txt"), "utf8");
    expect(notes).toBe(
      "prompt: EDIT_REPO please\n\nDone when:\ntests pass\n\nFirst run: npm ci\n\n" +
        "Before finishing, run these checks and report pass/fail:\n- test: npm test\n",
    );

    // The worktree is gone; the patch and final message are kept.
    const id = header(result, "job_id");
    expect(fs.existsSync(path.join(root, "tasks", "demo", id))).toBe(false);
    expect(fs.existsSync(path.join(root, "tasks", "demo", `${id}.patch`))).toBe(true);
    expect(fs.existsSync(path.join(root, "tasks", "demo", `${id}.last.md`))).toBe(true);
    expect(worktrees()).not.toContain(id);
    expect(result.content.some((c) => c.type === "resource_link")).toBe(true);
  });

  it("links a patch over the budget instead of inlining it, and the link can be read", async () => {
    const result = await call("codex_task", { project: "plain", ref: "main", task: "BIGPATCH:40000", wait_sec: 30 });
    expect(result.isError).toBe(false);
    const patch = section(result, "patch");
    expect(patch).toMatch(/^Saved to .*\.patch \(\d+ bytes\), not inlined: .*CODEX_MAX_PATCH_CHARS/);
    const link = result.content.find((c) => c.type === "resource_link") as unknown as { uri: string } | undefined;
    expect(link).toBeDefined();
    const read = await client().readResource({ uri: link!.uri });
    const text = (read.contents[0] as { text?: string }).text ?? "";
    expect(text.length).toBeGreaterThan(20000);
    const applied = applyOnCleanCheckout(header(result, "base"), text);
    expect(fs.statSync(path.join(applied, "big.txt")).size).toBeGreaterThanOrEqual(40000);
  });

  it("links but does not inline the patch when return is summary", async () => {
    const result = await call("codex_task", { project: "plain", ref: "main", task: "EDIT_REPO", return: "summary", wait_sec: 30 });
    expect(result.isError).toBe(false);
    expect(section(result, "patch")).toContain('not inlined because return is "summary"');
    expect(section(result, "diffstat")).toContain("README.md");
    expect(result.content.some((c) => c.type === "resource_link")).toBe(true);
  });

  it("runs review mode read-only and returns no patch", async () => {
    const result = await call("codex_task", { project: "plain", ref: "main", task: "EDIT_REPO review this", mode: "review", wait_sec: 30 });
    expect(result.isError).toBe(false);
    expect(section(result, "summary")).toContain("sandbox: read-only");
    expect(section(result, "summary")).toContain("writable roots: none");
    expect(section(result, "patch")).toBe("(review mode: no patch)");
    expect(result.content.some((c) => c.type === "resource_link")).toBe(false);
    const id = header(result, "job_id");
    expect(fs.existsSync(path.join(root, "tasks", "plain", `${id}.patch`))).toBe(false);
    expect(fs.existsSync(path.join(root, "tasks", "plain", id))).toBe(false);
  });

  it("reports a failed run and still removes the worktree", async () => {
    const result = await call("codex_task", { project: "plain", ref: "main", task: "please FAIL", wait_sec: 30 });
    expect(result.isError).toBe(true);
    expect(header(result, "status")).toBe("failed");
    expect(section(result, "summary")).toContain("refusing");
    const id = header(result, "job_id");
    expect(fs.existsSync(path.join(root, "tasks", "plain", id))).toBe(false);
    expect(worktrees()).not.toContain(id);
  });

  it("turns a fetch failure into a readable error and leaves no worktree", async () => {
    const before = worktrees();
    const result = await call("codex_task", { project: "plain", ref: "no-such-branch", task: "EDIT_REPO", wait_sec: 30 });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/Could not fetch "no-such-branch" from origin/);
    expect(worktrees()).toBe(before);
  });

  it("never runs repository hooks outside the sandbox", async () => {
    // Positive control: plain git in this clone does run the tracked hook.
    const control = path.join(scratch, "control-worktree");
    run(clone, "worktree", "add", "-q", "--detach", control, "origin/main");
    expect(fs.existsSync(marker)).toBe(true);
    run(clone, "worktree", "remove", "--force", control);
    fs.rmSync(marker);

    const result = await call("codex_task", { project: "plain", ref: "feature", task: "EDIT_REPO", wait_sec: 30 });
    expect(result.isError).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("rejects bad requests before starting a job", async () => {
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ ref: "-uupload-pack=evil" }, /Invalid ref/],
      [{ ref: "main..feature" }, /Invalid ref/],
      [{ ref: "main:refs/heads/x" }, /Invalid ref/],
      [{ ref: "+main" }, /Invalid ref/],
      [{ project: "nope" }, /Unknown project "nope"\. Configured projects: demo, plain/],
      [{ project: "demo", checks: ["test", "deploy"] }, /Unknown check "deploy".*Configured checks: lint, test/],
      [{ model: "gpt -c x" }, /Refusing to pass model/],
    ];
    for (const [overrides, message] of bad) {
      const result = await call("codex_task", { project: "plain", ref: "main", task: "EDIT_REPO", wait_sec: 30, ...overrides });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toMatch(message);
      expect(resultText(result)).not.toContain("job_id");
    }
    // Schema validation rejects wrong types and values before the handler runs.
    for (const overrides of [{ mode: "write" }, { checks: "test" }, { return: "diff" }]) {
      const result = await call("codex_task", { project: "plain", ref: "main", task: "EDIT_REPO", ...overrides });
      expect(result.isError).toBe(true);
    }
  });
});
