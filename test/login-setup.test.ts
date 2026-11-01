import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";

it("reads custom credentials without echoing either password entry", async () => {
  const password = "test-only-password-with-32-characters";
  // Pipes simulate terminal input; the test still runs the actual readline prompt code.
  const implementation = readFileSync(new URL("../src/login-setup.ts", import.meta.url), "utf8");
  const compiled = transformSync(implementation, { loader: "ts", format: "esm", target: "node20" }).code;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
  const source = `
    Object.defineProperty(process.stdin, 'isTTY', {value:true});
    Object.defineProperty(process.stderr, 'isTTY', {value:true});
    const {setupOwnerLogin} = await import(${JSON.stringify(moduleUrl)});
    const result = await setupOwnerLogin({username:'admin',password:''});
    process.stdout.write(JSON.stringify({username:result.username,length:result.password.length}));
  `;
  const env = { ...process.env };
  delete env.CODEX_MCP_USERNAME;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { env, windowsHide: true });
  let output = "";
  let prompts = "";
  let usernameSent = false;
  let passwordSent = false;
  let confirmationSent = false;
  const completed = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  child.stdout.on("data", chunk => { output += chunk.toString(); });
  child.stderr.on("data", chunk => {
    prompts += chunk.toString();
    if (!usernameSent && prompts.includes("Administrator username [admin]: ")) {
      usernameSent = true; child.stdin.write("custom-owner\n");
    }
    if (!passwordSent && prompts.includes("Administrator password (at least 24 characters): ")) {
      passwordSent = true; child.stdin.write(`${password}\n`);
    }
    if (!confirmationSent && prompts.includes("Repeat administrator password: ")) {
      confirmationSent = true; child.stdin.end(`${password}\n`);
    }
  });
  const timeout = setTimeout(() => child.kill(), 8000);
  try {
    expect(await completed).toBe(0);
    expect(JSON.parse(output)).toEqual({ username: "custom-owner", length: password.length });
    expect(prompts).not.toContain(password);
    expect(passwordSent && confirmationSent).toBe(true);
  } finally { clearTimeout(timeout); child.kill(); }
}, 10_000);
