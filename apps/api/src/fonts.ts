import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { GlobalFonts } from "@napi-rs/canvas";
import { FONTS, FONT_META, fontStyleFor, type FontKey } from "@rsp/shared";

const req = createRequire(import.meta.url);
let done = false;

/**
 * The production build embeds the font files the engine uses into the code itself (scripts/build.mjs, "<package>/<file>" -> base64).
 * A serverless host packages only the files it can see being used, and it cannot see font files that are found by name at run time, so
 * shipping them as separate files proved unreliable. In development and tests (not built) they are read from the installed packages.
 */
declare const __RSP_EMBEDDED_FONTS__: Record<string, string> | undefined;
const embedded: Record<string, string> | null = typeof __RSP_EMBEDDED_FONTS__ !== "undefined" ? __RSP_EMBEDDED_FONTS__ : null;

function filesDir(pkg: string): string {
  return path.join(path.dirname(req.resolve(`@fontsource/${pkg}/package.json`)), "files");
}

/**
 * Every face is registered under its OWN alias and chosen explicitly. (Matching several weights of one family by name proved
 * unreliable in the renderer: bold silently came out as regular. An explicit face can never fall back unnoticed.)
 */
export const faceAlias = (family: string, weight: 400 | 700, italic: boolean) => `${family}|${weight}|${italic ? "italic" : "normal"}`;
export const fontFamilies = (key: FontKey, bold: boolean, italic: boolean) => {
  const s = fontStyleFor(key, bold, italic);
  return `"${faceAlias(FONT_META[key].family, s.weight as 400 | 700, s.italic)}", "${faceAlias("Noto Sans Devanagari", s.weight as 400 | 700, false)}"`;
};

/** The font files the engine registers, as [package, file, alias]. The build embeds exactly these. */
export function fontFiles(): [string, string, string][] {
  const out: [string, string, string][] = [];
  for (const key of FONTS) {
    const m = FONT_META[key];
    for (const weight of m.bold ? [400, 700] as const : [400] as const)
      for (const italic of m.italic ? [false, true] : [false])
        out.push([m.pkg, `${m.pkg}-latin-${weight}-${italic ? "italic" : "normal"}.woff`, faceAlias(m.family, weight, italic)]);
  }
  for (const w of [400, 700] as const) out.push(["noto-sans-devanagari", `noto-sans-devanagari-devanagari-${w}-normal.woff`, faceAlias("Noto Sans Devanagari", w, false)]);
  return out;
}

/** Registers the bundled fonts with the renderer, once. Throws if any needed file is missing (never silently falls back). */
export function registerFonts() {
  if (done) return;
  for (const [pkg, file, alias] of fontFiles()) {
    if (embedded) {
      const b64 = embedded[`${pkg}/${file}`];
      if (!b64) throw new Error(`font missing from the build: ${pkg}/${file}`);
      if (!GlobalFonts.register(Buffer.from(b64, "base64"), alias)) throw new Error(`font could not be registered: ${pkg}/${file}`);
      continue;
    }
    const p = path.join(filesDir(pkg), file);
    if (!fs.existsSync(p)) throw new Error(`font file missing: ${p}`);
    if (!GlobalFonts.registerFromPath(p, alias)) throw new Error(`font could not be registered: ${p}`);
  }
  done = true;
}
