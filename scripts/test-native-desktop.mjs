// Drive the packaged WebView2 app through a test-only loopback debugging port.
// The application receives a separate LOCALAPPDATA. Saved user settings stay untouched.
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { createServer } from "node:net";
import {
  mkdir,
  mkdtemp,
  readFile,
  access,
  copyFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const mode = process.argv[2] ?? "clean";
assert.ok(
  ["clean", "legacy", "saved"].includes(mode),
  "Choose the clean, legacy, or saved-settings test fixture",
);
const app = path.resolve(
  mode === "legacy"
    ? "artifacts/legacy-upgrade-test-0.5/CodexMCP.exe"
    : "artifacts/native-desktop-0.7.1/payload/CodexMCP.exe",
);
const root = await mkdtemp(path.resolve("artifacts/desktop-native-test-"));
if (mode === "saved") {
  const source = path.join(process.env.LOCALAPPDATA, "CodexLocalMCPData");
  const destination = path.join(root, "CodexLocalMCPData");
  await mkdir(destination);
  const settings = JSON.parse(
    (await readFile(path.join(source, "settings.json"), "utf8")).replace(
      /^\uFEFF/,
      "",
    ),
  );
  settings.Workspace = path.join(root, "CodexMCPWorkspaces");
  await writeFile(
    path.join(destination, "settings.json"),
    JSON.stringify(settings),
  );
  await copyFile(
    path.join(source, "cloudflare.json"),
    path.join(destination, "cloudflare.json"),
  );
}
const listener = createServer();
await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const child = spawn(app, [], {
  windowsHide: true,
  env: {
    ...process.env,
    LOCALAPPDATA: root,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let browser;
let error = "";
child.stderr.on("data", (b) => (error += b.toString()));
try {
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null)
      throw new Error(`Desktop exited: ${child.exitCode} ${error}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  let page;
  for (let i = 0; i < 40; i++) {
    page = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().includes("tauri.localhost"));
    if (page) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(page, "The packaged WebView2 page must open");
  await page.getByRole("heading", { name: "Choose a place to work" }).waitFor();
  const state = () =>
    page.evaluate(() => window.__TAURI__.core.invoke("state"));
  assert.equal((await state()).version, "0.7.1");
  if (mode === "saved") {
    assert.equal((await state()).settings.passwordSaved, true);
    const account = await page.evaluate(() =>
      window.__TAURI__.core.invoke("cloudflare_status"),
    );
    assert.equal(account.signedIn, true);
    assert.ok(account.domains.length > 0);
    console.log(
      "Existing encrypted C# settings and Cloudflare sign-in imported and validated.",
    );
  }
  await page.getByRole("button", { name: "2 Accounts" }).click();
  await page
    .locator("#openai-state")
    .filter({ hasText: "Not signed in" })
    .waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: "Generate secure password" }).click();
  await page
    .getByText("Secure password generated and saved.", { exact: false })
    .waitFor();
  assert.equal((await state()).settings.passwordSaved, true);
  const disk = JSON.parse(
    await readFile(path.join(root, "CodexLocalMCPData/settings.json"), "utf8"),
  );
  assert.ok(disk.Password.length > 48);
  assert.ok(
    !/^[a-f0-9]{48}$/.test(disk.Password),
    "The saved password must be DPAPI encrypted",
  );
  assert.equal(
    await access(path.join(path.dirname(app), "runtime/node/node.exe")).then(
      () => true,
      () => false,
    ),
    false,
    "The running Rust application must not retain the legacy Node runtime",
  );
  await page.getByRole("button", { name: "1 Workspace" }).click();
  await page.getByText("Task and image settings", { exact: true }).click();
  await page.locator("#image-size").fill("512x512");
  await page.locator("#image-compression").fill("75");
  await page.locator("#image-budget").fill("128");
  await page
    .getByRole("button", { name: "Save and continue →", exact: true })
    .click();
  assert.equal((await state()).settings.execution.size, "512x512");
  assert.equal((await state()).settings.execution.target_file_kb, 128);
  const persisted = JSON.parse(
    await readFile(path.join(root, "CodexLocalMCPData/settings.json"), "utf8"),
  );
  assert.equal(persisted.Execution.output_compression, 75);
  await page.getByRole("button", { name: "1 Workspace" }).click();
  await page
    .getByRole("button", { name: "Check sandbox", exact: true })
    .click();
  await page
    .getByText("Sandbox check passed.", { exact: false })
    .waitFor({ timeout: 60000 });
  await mkdir("artifacts/desktop-ui", { recursive: true });
  await page.screenshot({ path: "artifacts/desktop-ui/native-app.png" });
  console.log(
    "Packaged Rust desktop passed: real WebView2, restricted IPC, saved DPAPI password, account status, and actual MXC sandbox.",
  );
} catch (error) {
  if (browser)
    for (const page of browser.contexts().flatMap((c) => c.pages())) {
      try {
        console.error(
          (await page.locator("#notice").innerText({ timeout: 1000 })).slice(
            0,
            500,
          ),
        );
        await page.screenshot({
          path: "artifacts/desktop-ui/native-failure.png",
          timeout: 3000,
        });
      } catch {}
    }
  throw error;
} finally {
  if (child.exitCode === null) child.kill();
  if (browser)
    await Promise.race([
      browser.close(),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
}
