// Bundles the in-chat image view (ui/image-viewer.ts) into one self-contained
// HTML file, dist/ui/image-viewer.html, which the server serves as an MCP App
// resource. Hosts render it in a sandboxed frame whose default policy allows
// inline scripts and styles but no network, so everything must be inline.
import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outFile = path.join(root, "dist", "ui", "image-viewer.html");

const result = await build({
  entryPoints: [path.join(root, "ui", "image-viewer.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  write: false,
  legalComments: "none",
});
// A "</script>" inside the bundle would end the inline script early.
const script = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");

const css = `
  :root { color-scheme: light dark; --fg: #1f1f1f; --muted: #6b6b6b; --line: #e3e3e3; --err: #b3261e; }
  @media (prefers-color-scheme: dark) { :root { --fg: #ececec; --muted: #a0a0a0; --line: #3a3a3a; --err: #f2b8b5; } }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 8px 0; font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg); background: transparent; }
  figure { margin: 0 0 12px; }
  img { display: block; max-width: 100%; height: auto; border-radius: 10px; border: 1px solid var(--line); }
  figcaption { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; font-size: 12px; }
  .path, .workspace { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; }
  .workspace { font-size: 11px; color: var(--muted); word-break: break-all; }
  .muted { color: var(--muted); }
  .note { font-size: 12px; color: var(--muted); margin: 4px 0; }
  .error { color: var(--err); margin-bottom: 8px; }
  .status { display: flex; align-items: center; gap: 8px; padding: 12px 0; }
  .spinner { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--line); border-top-color: var(--fg); animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
`;

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Codex image</title>
<style>${css}</style>
</head>
<body>
<div id="root" role="region" aria-live="polite" aria-label="Codex image"></div>
<script>${script}</script>
</body>
</html>
`;

await fs.mkdir(path.dirname(outFile), { recursive: true });
await fs.writeFile(outFile, html);
console.error(`built ${path.relative(root, outFile)} (${html.length} bytes)`);
