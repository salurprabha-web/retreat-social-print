// Production build: bundles the server and the shared package into dist/, leaving every other dependency to be loaded from node_modules
// (native modules such as sharp, canvas and argon2 cannot be bundled, and pdfkit reads its font files from its own folder).
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
// Bundled instead of loaded at run time: the shared package, and Fastify with its cookie plugins. Fastify's request injector (used by the
// serverless entry) and @fastify/cookie require() the "cookie" package, which is ES-module only; some runtimes (Vercel's functions) refuse
// require() of an ES module (ERR_REQUIRE_ESM). Bundling converts it once, at build time, so nothing depends on that runtime feature.
const BUNDLED = new Set(["@rsp/shared", "fastify", "@fastify/cookie", "@fastify/rate-limit"]);
const external = [...Object.keys(pkg.dependencies ?? {}).filter((d) => !BUNDLED.has(d)), "node:*"];

// The font files the picture engine registers (see fontFiles() in src/fonts.ts: regular/bold, upright/italic Latin, and Devanagari),
// embedded into the code as base64. A host that packages only the files it sees being used (Vercel) would otherwise miss them.
const { createRequire } = await import("node:module");
const reqFrom = createRequire(path.join(root, "package.json"));
const fonts = {};
for (const dep of Object.keys(pkg.dependencies ?? {}).filter((d) => d.startsWith("@fontsource/"))) {
  const name = dep.split("/")[1];
  const dir = path.join(path.dirname(reqFrom.resolve(`${dep}/package.json`)), "files");
  for (const f of fs.readdirSync(dir)) {
    if (/^.+-latin-(400|700)-(normal|italic)\.woff$/.test(f) || /^noto-sans-devanagari-devanagari-(400|700)-normal\.woff$/.test(f)) fonts[`${name}/${f}`] = fs.readFileSync(path.join(dir, f)).toString("base64");
  }
}
console.log(`embedding ${Object.keys(fonts).length} font files (${Math.round(Object.values(fonts).reduce((n, s) => n + s.length, 0) / 1024)} KB as text)`);

fs.rmSync(path.join(root, "dist"), { recursive: true, force: true });
await build({
  define: { __RSP_EMBEDDED_FONTS__: JSON.stringify(fonts) },
  entryPoints: [path.join(root, "src/index.ts"), path.join(root, "src/serverless.ts"), path.join(root, "src/migrate-cli.ts"), path.join(root, "src/seed-admin.ts"), path.join(root, "src/openapi-cli.ts")],
  outdir: path.join(root, "dist"), bundle: true, platform: "node", target: "node22", format: "esm", splitting: true, sourcemap: true, external, logLevel: "info",
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },     // some bundled CommonJS code expects require()
});
fs.writeFileSync(path.join(root, "dist/package.json"), JSON.stringify({ type: "module" }));
console.log("built dist/ (migrations are read from ../migrations next to dist)");
