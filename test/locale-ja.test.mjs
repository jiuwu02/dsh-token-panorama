/**
 * Japanese fallback locale: identical key set, ignored unknown overrides.
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const load = (relative) => import(pathToFileURL(join(root, relative)).href);
const m = await load("lib/locale-ja.js");

const base = { a: "A", b: "B", c: "C", d: "D", e: "E" };
const ja = m.japaneseLocale(base);
assert.deepEqual(Object.keys(ja).sort(), Object.keys(base).sort(),
  "the fallback locale has exactly the base key set");
const overrides = { a: "あ", notAKey: "ignored", c: "シー" };
const merged = m.makeLocale(base, overrides);
assert.equal(merged.a, "あ");
assert.equal(merged.c, "シー");
assert.equal(merged.notAKey, undefined, "an unknown override key is ignored");
assert.equal(merged.b, "B", "untouched keys fall back to English");
assert.ok(Object.keys(m.JA_OVERRIDES).length >= 30, "a meaningful set of visible labels");
assert.deepEqual(m.localeCoverage(base, merged), { total: 5, translated: 2, fallback: 3 });
assert.deepEqual(m.localeCoverage(base, base), { total: 5, translated: 0, fallback: 5 });

console.log("locale-ja ok: key set, overrides, coverage");
