import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
await promisify(execFile)(process.execPath, [
  "node_modules/typescript/bin/tsc",
  "--project",
  "native/desktop-ui",
]);
const output = "native/desktop-ui/dist";
await mkdir(output, { recursive: true });
await build({
  entryPoints: ["native/desktop-ui/app.ts"],
  outfile: `${output}/app.js`,
  bundle: true,
  minify: true,
  format: "esm",
  target: "es2022",
});
for (const name of ["index.html", "style.css"])
  await copyFile(`native/desktop-ui/${name}`, `${output}/${name}`);
await copyFile(
  "installer/windows/Manager/Assets/logo.png",
  `${output}/logo.png`,
);
