import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';

const payload = path.resolve(process.argv[2] || '');
const boundary = path.resolve('artifacts') + path.sep;
if (!payload.startsWith(boundary)) throw new Error('Desktop bundle output must stay inside artifacts.');
const app = path.join(payload, 'app');
const modules = path.join(app, 'node_modules');
const notices = [];
// Preserve the dependency licences before discarding bundled package source files.
async function licences(directory) {
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, item.name);
    if (item.isSymbolicLink()) continue;
    if (item.isDirectory()) await licences(full);
    else if (/^(licen[cs]e|copying|notice)([.-]|$)/i.test(item.name))
      notices.push(`\n--- ${path.relative(modules, full)} ---\n${await fs.readFile(full, 'utf8')}`);
  }
}
await licences(modules);
await fs.writeFile(path.join(payload, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n'));
const options = {
  bundle: true, platform: 'node', format: 'esm', target: 'node24', minify: true,
  external: ['sharp'], legalComments: 'eof',
  banner: { js: 'import { createRequire as __desktopRequire } from "node:module"; const require = __desktopRequire(import.meta.url);' },
};
await build({ ...options,
  entryPoints: ['src/index.ts', 'src/server.ts', 'src/http.ts', 'src/sandbox-probe.ts', 'src/sandbox-check-child.ts'],
  outdir: path.join(app, 'dist'),
});
await build({ ...options, entryPoints: ['installer/windows/verify-bundle.mjs'],
  external: ['./app/dist/server.js', './app/dist/http.js'], outfile: path.join(payload, 'verify-installed.mjs') });
// Sharp has a native Windows module and DLLs. Keep it and its small JS dependency graph.
// All other production packages are now inside the checked server bundles.
const keep = new Set(['sharp', '@img', 'detect-libc', 'semver']);
for (const item of await fs.readdir(modules, { withFileTypes: true })) {
  if (keep.has(item.name)) continue;
  const full = path.resolve(modules, item.name);
  if (!full.startsWith(path.resolve(modules) + path.sep)) throw new Error('Unsafe dependency removal path.');
  if (item.isSymbolicLink()) await fs.unlink(full);
  else await fs.rm(full, { recursive: item.isDirectory(), force: true });
}
console.log('Bundled desktop server; retained native Sharp dependencies and third-party licences.');
