// Captures the screenshots in docs/images from the built desktop UI with a mock
// backend, so the guide can be refreshed after UI changes without a real
// connection, account, or tunnel. All names, addresses, and paths are examples.
//
// Run: node scripts/build-desktop-ui.mjs && node scripts/capture-guide-images.mjs
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";

const dist = "native/desktop-ui/dist/";
const out = "docs/images/";
const routes = {
  "/": ["index.html", "text/html"],
  "/app.js": ["app.js", "text/javascript"],
  "/style.css": ["style.css", "text/css"],
  "/logo.png": ["logo.png", "image/png"],
};
const server = createServer(async (req, res) => {
  const route = routes[req.url];
  if (!route) return res.writeHead(404).end();
  res.setHeader("Content-Type", route[1]).end(await readFile(dist + route[0]));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
await mkdir(out, { recursive: true });
const version = JSON.parse(await readFile("native/desktop/tauri.conf.json", "utf8")).version;

// Each shot loads the app in one state and opens one page.
const shots = [
  { name: "1-workspace", page: "workspace", state: "fresh" },
  { name: "2-accounts", page: "accounts", state: "ready" },
  { name: "3-connection", page: "connection", state: "ready" },
  { name: "4-claude", page: "claude", state: "running" },
  { name: "5-activity", page: "activity", state: "running" },
];

const browser = await chromium.launch();
for (const shot of shots) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 820 }, deviceScaleFactor: 1.5 });
  page.on("pageerror", (e) => {
    throw e;
  });
  await page.addInitScript(
    ({ state, version }) => {
      const fresh = state === "fresh";
      const running = state === "running";
      const settings = {
        workspace: "C:\\Users\\me\\CodexWorkspaces",
        username: "admin",
        passwordSaved: !fresh,
        tunnel: "quick",
        tokenSaved: false,
        publicUrl: "",
        backend: "mxc",
        network: false,
        port: 3000,
        showPrompts: running,
      };
      const options = { count: 2, size: "1024x1024", quality: "low", output_format: "jpeg", output_compression: 80, background: "opaque", target_file_kb: 256, timeout_sec: 300 };
      const image = {
        id: "job-2",
        action: "codex_generate_image",
        status: "completed",
        phase: "collecting_files",
        parallel: 2,
        elapsedMs: 58000,
        idleMs: 0,
        steps: 6,
        history: [
          { phase: "preparing", atMs: 200 },
          { phase: "generating_image", atMs: 1500 },
          { phase: "collecting_files", atMs: 55000 },
        ],
        options,
        workspace: "C:\\Users\\me\\CodexWorkspaces\\fox-poster",
        files: 2,
        exitCode: 0,
        outputFiles: [
          { name: "fox-poster-1.jpg", bytes: 183500, width: 1024, height: 1024 },
          { name: "fox-poster-2.jpg", bytes: 176200, width: 1024, height: 1024 },
        ],
        usage: { input_tokens: 8420, output_tokens: 1024 },
        prompt: "A poster of a red fox standing in fresh snow at dawn.\nSoft pink light, mountains behind, minimal flat illustration style.\nLeave empty space at the top for a title.",
        promptChars: 150,
        promptTruncated: false,
      };
      const connection = running
        ? { connected: true, running: true, status: "Connected", endpoint: "https://example-words-here.trycloudflare.com/mcp", lastRequest: { action: "codex_generate_image", at: Date.now() / 1000 }, tasks: [image] }
        : { connected: false, running: false, status: "Stopped", endpoint: "", tasks: [] };
      window.__TAURI__ = {
        event: { listen: async () => {} },
        core: {
          invoke: async (name) => {
            switch (name) {
              case "state":
                return { settings, connection, update: null, version };
              case "account_status":
                return fresh ? { signedIn: false } : { signedIn: true, email: "you@example.com", method: "chatgpt" };
              case "cloudflare_status":
                return { signedIn: false, domains: [] };
              default:
                return;
            }
          },
        },
      };
    },
    { state: shot.state, version },
  );
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForTimeout(500);
  await page.locator(`nav button[data-page=${shot.page}]`).click();
  await page.waitForTimeout(300);
  if (shot.page === "activity") {
    const prompt = page.locator(".task-prompt").first();
    if (await prompt.count()) await prompt.evaluate((e) => (e.open = true));
    // Grow the window instead of a full-page capture, which leaves the
    // viewport-height sidebar short of the page.
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width: 1100, height });
    await page.waitForTimeout(150);
  }
  await page.screenshot({ path: `${out}${shot.name}.png` });
  await page.close();
  console.log(`${out}${shot.name}.png`);
}
await browser.close();
server.close();
