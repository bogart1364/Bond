#!/usr/bin/env node
/**
 * Glyph scan — enforces the platform's zero-glyph rule.
 *
 * Bond renders no emoji and no symbol glyphs (stars, arrows, checks,
 * bullets, …). Everything visual is either type or a themed SVG
 * engraving. The only permitted non-ASCII characters are typographic
 * punctuation used by the newspaper art direction and the box-drawing
 * rule `─` (U+2500) used as a comment separator.
 *
 * Exit code 1 when anything outside the allowlist is found.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** Directories walked. */
const TARGETS = ["web/src", "src", "test", "script"];

/** Source extensions scanned. */
const EXT = new Set([".ts", ".tsx", ".css", ".sol", ".html", ".json", ".md", ".mjs", ".js"]);

/**
 * Allowlist — typographic punctuation and the comment rule only.
 *   U+2011 non-breaking hyphen is deliberately NOT allowed (the
 *   platform spells hyphenated words with a normal hyphen so text can
 *   be copied, searched and read by screen readers).
 */
const ALLOWED = new Set([
  0x2500, // ─ box drawing light horizontal (comment rule)
  0x2014, // em dash
  0x2013, // en dash
  0x2018, // left single quote
  0x2019, // right single quote
  0x201c, // left double quote
  0x201d, // right double quote
  0x2026, // ellipsis
  0x00b7, // middle dot
  0x00a0, // no-break space
  0x2022, // bullet (list markers in docs)
  0x00d7, // multiplication sign (close affordance)
  0x00a9, // copyright (footer colophon)
  0x00a7, // section sign (legal-style section index)
  0x00b0, // degree sign (rotation values in CSS)
]);

/** Emoji / pictograph ranges — hard banned regardless of allowlist. */
const EMOJI = [
  [0x1f300, 0x1faff],
  [0x2600, 0x27bf],
  [0x2b00, 0x2bff],
  [0x1f000, 0x1f2ff],
  [0xfe0f, 0xfe0f], // variation selector-16
  [0x2190, 0x21ff], // arrows
  [0x2700, 0x27bf], // dingbats
];

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name === "out" || name === "cache" || name === "lib")
      continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (EXT.has(extname(name).toLowerCase())) out.push(full);
  }
  return out;
}

const offenders = [];

for (const t of TARGETS) {
  const dir = join(root, t);
  for (const file of walk(dir)) {
    const text = readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const ch of line) {
        const cp = ch.codePointAt(0);
        if (cp < 0x80) continue;
        const inEmoji = EMOJI.some(([a, b]) => cp >= a && cp <= b);
        if (inEmoji || !ALLOWED.has(cp)) {
          offenders.push({
            file: relative(root, file),
            line: i + 1,
            char: ch,
            code: "U+" + cp.toString(16).toUpperCase().padStart(4, "0"),
          });
        }
      }
    });
  }
}

if (offenders.length === 0) {
  console.log("glyph scan: clean (only allowlisted typographic characters)");
  process.exit(0);
}

console.error(`glyph scan: ${offenders.length} offending glyph(s)\n`);
const seen = new Set();
for (const o of offenders) {
  const key = `${o.file}:${o.line}:${o.code}`;
  if (seen.has(key)) continue;
  seen.add(key);
  console.error(`  ${o.file}:${o.line}  ${o.code}  ${o.char}`);
}
console.error(
  "\nOnly typographic punctuation and U+2500 are allowed. Use SVG engraving icons instead of glyphs.",
);
process.exit(1);
