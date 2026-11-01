import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

/** Read a password locally without terminal echo or persistent credential files. */
async function secret(prompt: string): Promise<string> {
  const silent = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const input = createInterface({ input: process.stdin, output: silent, terminal: true });
  const controller = new AbortController();
  input.once("SIGINT", () => controller.abort());
  input.once("close", () => controller.abort());
  process.stderr.write(prompt);
  try { return await input.question("", { signal: controller.signal }); }
  finally { input.close(); process.stderr.write("\n"); }
}

export async function setupOwnerLogin<T extends { username: string; password: string }>(options: T): Promise<T> {
  if (options.password) return options;
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error("Set CODEX_MCP_PASSWORD, or run npm run start:tunnel in an interactive terminal to set the login.");
  }
  console.error("Set the administrator login for this server session. Codex keeps its existing local login.");
  if (!process.env.CODEX_MCP_USERNAME) {
    const input = createInterface({ input: process.stdin, output: process.stderr });
    try { options.username = (await input.question("Administrator username [admin]: ")).trim() || "admin"; }
    finally { input.close(); }
  }
  while (!options.password) {
    const password = await secret("Administrator password (at least 24 characters): ");
    if (password.length < 24 || Buffer.byteLength(password) > 1024) {
      console.error("Use at least 24 characters and no more than 1024 UTF-8 bytes.");
      continue;
    }
    if (password !== await secret("Repeat administrator password: ")) {
      console.error("The passwords do not match. Try again.");
      continue;
    }
    options.password = password;
  }
  return options;
}
