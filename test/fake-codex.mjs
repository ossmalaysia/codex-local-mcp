// Stands in for the real codex CLI so tests run without it installed.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (args[0] === "login" && args[1] === "status") {
  process.exit(process.env.FAKE_CODEX_LOGGED_OUT === "1" ? 1 : 0);
}
const cdIndex = args.indexOf("--cd");
const cwd = cdIndex >= 0 ? args[cdIndex + 1] : process.cwd();
const lastIndex = args.indexOf("--output-last-message");
const sandboxIndex = args.indexOf("--sandbox");

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (prompt += chunk));
process.stdin.on("end", () => {
  if (prompt.includes("FAIL")) {
    process.stderr.write("fake codex: refusing\n");
    process.exit(2);
  }
  if (prompt.includes("HANG")) {
    setInterval(() => {}, 1000);
    return;
  }

  // "SLOW:<ms>" delays the work, standing in for a run that outlasts a call.
  const slow = /SLOW:(\d+)/.exec(prompt);
  setTimeout(() => finish(), slow ? Number(slow[1]) : 0);
});

function finish() {
  fs.writeFileSync(path.join(cwd, "notes.txt"), `prompt: ${prompt}\n`);
  fs.mkdirSync(path.join(cwd, "output"), { recursive: true });
  // 1x1 transparent PNG.
  fs.writeFileSync(
    path.join(cwd, "output", "img.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  // "EDIT_REPO" stands in for a coding task: change a tracked file, add new ones.
  if (prompt.includes("EDIT_REPO")) {
    fs.appendFileSync(path.join(cwd, "README.md"), "Edited by fake codex.\n");
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "added.txt"), "a new untracked file\n");
  }
  // "BIGPATCH:<n>" writes roughly n characters of new text, for patch budgets.
  const big = /BIGPATCH:(\d+)/.exec(prompt);
  if (big) fs.writeFileSync(path.join(cwd, "big.txt"), "x".repeat(79).concat("\n").repeat(Math.ceil(Number(big[1]) / 80)));
  // Codex writes its final message to --output-last-message; tests read the
  // sandbox and cache it was given from here.
  if (lastIndex >= 0) {
    fs.writeFileSync(
      args[lastIndex + 1],
      `fake codex final message\nsandbox: ${sandboxIndex >= 0 ? args[sandboxIndex + 1] : "none"}\n` +
        `npm cache: ${process.env.npm_config_cache ?? "unset"}\n` +
        `writable roots: ${args.find((a) => a.startsWith("sandbox_workspace_write.writable_roots=")) ?? "none"}\n`,
    );
  }
  process.stdout.write("fake codex: wrote notes.txt and output/img.png\n");
  process.exit(0);
}
