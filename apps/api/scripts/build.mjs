// Production build: bundles the server and the shared package into dist/, leaving every other dependency to be loaded from node_modules
// (native modules such as sharp, canvas and argon2 cannot be bundled, and pdfkit reads its font files from its own folder).
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const external = [...Object.keys(pkg.dependencies ?? {}).filter((d) => d !== "@rsp/shared"), "node:*"];

fs.rmSync(path.join(root, "dist"), { recursive: true, force: true });
await build({
  entryPoints: [path.join(root, "src/index.ts"), path.join(root, "src/serverless.ts"), path.join(root, "src/migrate-cli.ts"), path.join(root, "src/seed-admin.ts"), path.join(root, "src/openapi-cli.ts")],
  outdir: path.join(root, "dist"), bundle: true, platform: "node", target: "node22", format: "esm", splitting: true, sourcemap: true, external, logLevel: "info",
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },     // some bundled CommonJS code expects require()
});
fs.writeFileSync(path.join(root, "dist/package.json"), JSON.stringify({ type: "module" }));
console.log("built dist/ (migrations are read from ../migrations next to dist)");
