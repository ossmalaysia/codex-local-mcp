// Stands in for the real codex CLI so tests run without it installed.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const cdIndex = args.indexOf("--cd");
const cwd = cdIndex >= 0 ? args[cdIndex + 1] : process.cwd();

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
  process.stdout.write("fake codex: wrote notes.txt and output/img.png\n");
  process.exit(0);
}
