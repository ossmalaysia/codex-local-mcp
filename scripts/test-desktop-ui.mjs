// Browser checks use the real embedded interface and a local, explicit test adapter.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
const routes = {
  "/": "index.html",
  "/app.js": "app.js",
  "/style.css": "style.css",
  "/logo.png": "logo.png",
};
const server = createServer(async (req, res) => {
  const name = routes[req.url];
  if (!name) {
    res.writeHead(404).end();
    return;
  }
  const mime = {
    "app.js": "text/javascript",
    "style.css": "text/css",
    "logo.png": "image/png",
  };
  res.setHeader("Content-Type", mime[name] ?? "text/html");
  res.end(await readFile(`native/desktop-ui/dist/${name}`));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1120, height: 820 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    let settings = {
      workspace: "C:\\Workspaces",
      username: "admin",
      passwordSaved: true,
      tunnel: "named",
      tokenSaved: true,
      publicUrl: "https://codex.example.com",
      backend: "mxc",
      network: false,
      port: 3000,
    };
    let connection = {
        connected: false,
        running: false,
        status: "Stopped",
        endpoint: "",
        tasks: [],
      },
      update = null;
    window.__TAURI__ = {
      event: { listen: async () => {} },
      core: {
        invoke: async (name, args) => {
          switch (name) {
            case "state": {
              // The service reports a post-update reconnect once.
              const resumed = window.__resumed ?? null;
              window.__resumed = null;
              return {
                settings,
                connection,
                update,
                version: "0.7.0",
                resumed,
              };
            }
            case "account_status":
              return {
                signedIn: true,
                email: "test@example.com",
                method: "chatgpt",
              };
            case "cloudflare_status":
              return {
                signedIn: true,
                domains: [{ id: "test", name: "example.com" }],
              };
            case "save_settings":
              settings = { ...settings, ...args.input };
              window.__saved = args.input;
              return settings;
            case "generate_password":
              return { ...settings, passwordSaved: true };
            case "start_connection":
              connection = {
                ...connection,
                connected: true,
                running: true,
                status: "Connected",
                endpoint: "https://codex.example.com/mcp",
                lastRequest: { action: "codex_generate_image", at: 1 },
                tasks: [
                  {
                    id: "test-job",
                    action: "codex_generate_image",
                    status: "running",
                    phase: "running_command",
                    elapsedMs: 5000,
                    idleMs: 1000,
                    steps: 3,
                    history: [
                      { phase: "generating_image", atMs: 1000 },
                      { phase: "writing_files", atMs: 4000 },
                    ],
                    options: {
                      model: "gpt-6.1-sol",
                      reasoning_effort: "low",
                      timeout_sec: 180,
                      count: 1,
                      size: "512x512",
                      quality: "low",
                      output_format: "jpeg",
                      output_compression: 75,
                      background: "opaque",
                      target_file_kb: 128,
                    },
                    outputFiles: [
                      {
                        name: "output/image.jpg",
                        bytes: 65536,
                        width: 512,
                        height: 512,
                      },
                    ],
                    workspace: "C:\\Workspaces\\test",
                    prompt: "Draw a red fox in fresh snow.\nUse soft light.",
                    promptChars: 46,
                    promptTruncated: false,
                  },
                ],
              };
              return;
            case "stop_connection":
              connection = {
                ...connection,
                connected: false,
                running: false,
                status: "Stopped",
              };
              return;
            case "check_update":
              update = { version: "0.8.0" };
              return { available: true, update };
            case "sandbox_check":
              throw new Error("Sandbox check failed: test error");
            case "copy_password":
              return;
            default:
              throw new Error(`Unexpected test command: ${name}`);
          }
        },
      },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole("button", { name: "2 Accounts" }).click();
  await page.getByText("Signed in as test@example.com").waitFor();
  assert.equal(
    await page.locator("#password-state").innerText(),
    "Password saved",
  );
  assert.equal(await page.locator("#password").inputValue(), "");
  assert.equal(await page.locator("#copy-password").isEnabled(), true);
  await page.locator("nav button.done[data-page=accounts]").waitFor();
  await page.getByRole("button", { name: "4 Use in Claude" }).click();
  assert.equal(
    await page.locator("#endpoint").inputValue(),
    "https://codex.example.com/mcp",
  );
  await page
    .locator("#claude")
    .getByRole("button", { name: "Start connection", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "3 Connection" }).click();
  await page.getByText("Address saved: https://codex.example.com").waitFor();
  assert.equal(await page.locator("#cloudflare-setup").isVisible(), false);
  await page.getByRole("button", { name: "Change address" }).click();
  await page.getByText("Your address: https://codex.example.com").waitFor();
  await page
    .getByRole("button", { name: "Start connection", exact: true })
    .click();
  await page.getByRole("button", { name: /Activity/ }).click();
  await page.getByText("Generate image", { exact: true }).waitFor();
  assert.match(
    await page.locator("#last-request").innerText(),
    /codex_generate_image/,
  );
  await page.getByText("Generating the image", { exact: false }).waitFor();
  await page.locator("#tasks .badge.busy", { hasText: "Running" }).waitFor();
  await page.locator("nav button.done[data-page=connection]").waitFor();
  await page.getByText("Prompt sent by Claude").waitFor();
  await page.getByText(/Draw a red fox in fresh snow/).waitFor();
  // The prompt block survives the one-second refresh, so it keeps its state.
  const prompt = await page.locator(".task-prompt").elementHandle();
  await page.waitForTimeout(1200);
  assert.equal(await prompt.evaluate((el) => el.isConnected), true);
  assert.equal(await page.locator("#show-prompts").isDisabled(), true);
  await page.getByText("Target: 128 KB", { exact: true }).waitFor();
  await page.getByText(/64.0 KB.*512×512/).waitFor();
  assert.equal(await page.locator("#image-format").inputValue(), "jpeg");
  await mkdir("artifacts/desktop-ui", { recursive: true });
  await page.screenshot({ path: "artifacts/desktop-ui/activity.png" });
  await page
    .getByRole("button", { name: "Check for updates", exact: true })
    .click();
  await page.getByRole("button", { name: "Install version 0.8.0" }).waitFor();
  await page.getByRole("button", { name: "1 Workspace" }).click();
  // Settings are locked, not rejected, while the connection runs.
  assert.equal(await page.locator("#folder").isDisabled(), true);
  await page.getByRole("button", { name: "Stop connection" }).click();
  await page.locator("#locked-note").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#folder").isDisabled(), false);
  await page
    .getByRole("button", { name: "Check sandbox", exact: true })
    .click();
  assert.match(
    await page.locator("#notice").innerText(),
    /Sandbox check failed/,
  );
  await page.getByRole("button", { name: "Dismiss message" }).click();
  assert.equal(await page.locator("#notice-bar").isVisible(), false);
  // An invalid setting is reported at its field and never reaches the service.
  await page.getByText("Task and image settings").click();
  await page.locator("#image-count").fill("0");
  await page
    .locator("#workspace")
    .getByRole("button", { name: "Save and continue →" })
    .click();
  assert.match(await page.locator("#notice").innerText(), /Image count/);
  assert.equal(await page.locator("#workspace").isVisible(), true);
  await page.locator("#image-count").fill("1");
  await page.getByRole("button", { name: /Activity/ }).click();
  await page.locator("#show-prompts").check();
  await page.getByText("Prompts will show in Activity").waitFor();
  assert.equal(await page.evaluate(() => window.__saved.showPrompts), true);
  // After an update restarts the connection, the window says so once.
  await page.getByRole("button", { name: "1 Workspace" }).click();
  await page.evaluate(() => (window.__resumed = { ok: true }));
  await page.getByText("The connection started again.").waitFor();
  assert.equal(await page.locator("#activity").isVisible(), true);
  await page.evaluate(
    () => (window.__resumed = { ok: false, error: "Tunnel unavailable" }),
  );
  await page.getByText(/did not start again: Tunnel unavailable/).waitFor();
  await page.setViewportSize({ width: 800, height: 620 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  // The sidebar footer must not overlap the navigation in a short window.
  assert.equal(
    await page.evaluate(
      () =>
        document.querySelector("nav").getBoundingClientRect().bottom <=
        document.querySelector(".sidebar-bottom").getBoundingClientRect().top,
    ),
    true,
  );
  assert.deepEqual(errors, []);
  console.log(
    "Desktop UI passed: saved accounts, step status, saved hostname, connection, live activity, update notice, errors, field validation, locked settings, prompt display, update reconnect, minimum window size.",
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
