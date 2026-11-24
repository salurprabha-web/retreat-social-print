import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { GlobalFonts } from "@napi-rs/canvas";
import { FONTS, FONT_META, fontStyleFor, type FontKey } from "@rsp/shared";

const req = createRequire(import.meta.url);
let done = false;

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

/** Registers the bundled fonts with the renderer, once. Throws if any needed file is missing (never silently falls back). */
export function registerFonts() {
  if (done) return;
  const reg = (dir: string, file: string, alias: string) => {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) throw new Error(`font file missing: ${p}`);
    if (!GlobalFonts.registerFromPath(p, alias)) throw new Error(`font could not be registered: ${p}`);
  };
  for (const key of FONTS) {
    const m = FONT_META[key]; const dir = filesDir(m.pkg);
    for (const weight of m.bold ? [400, 700] as const : [400] as const)
      for (const italic of m.italic ? [false, true] : [false])
        reg(dir, `${m.pkg}-latin-${weight}-${italic ? "italic" : "normal"}.woff`, faceAlias(m.family, weight, italic));
  }
  const dd = filesDir("noto-sans-devanagari");
  for (const w of [400, 700] as const) reg(dd, `noto-sans-devanagari-devanagari-${w}-normal.woff`, faceAlias("Noto Sans Devanagari", w, false));
  done = true;
}
