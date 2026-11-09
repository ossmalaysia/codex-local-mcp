// Stands in for the real codex CLI so tests run without it installed.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (args[0] === "login" && args[1] === "status") {
  process.exit(process.env.FAKE_CODEX_LOGGED_OUT === "1" ? 1 : 0);
}
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
  // "SLEEP" stands in for a long run that gets cancelled: it writes a partial
  // file, starts a grandchild so the whole tree has to be killed, records both
  // process ids in pids.txt, then waits forever.
  if (prompt.includes("SLEEP")) {
    fs.writeFileSync(path.join(cwd, "partial.txt"), "written before cancel\n");
    const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    fs.writeFileSync(path.join(cwd, "pids.txt"), `${process.pid} ${grandchild.pid}\n`);
    setInterval(() => {}, 1000);
    return;
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
