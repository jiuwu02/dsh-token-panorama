/**
 * Price sync: normalization, graceful failure, and manual-sheet authority.
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const load = (relative) => import(pathToFileURL(join(root, relative)).href);
const m = await load("lib/price-sync.js");

const arrayPayload = [
  { key: "b/model", input: 2, cacheRead: 0.2, cacheWrite: 1, output: 8 },
  { key: "a/model", input: 1, cacheRead: 0.1, cacheWrite: 0.5, output: 4 },
  { key: "", input: 1, cacheRead: 1, cacheWrite: 1, output: 1 },
  { key: "bad/model", input: -1, cacheRead: 1, cacheWrite: 1, output: 1 },
];
const fakeFetch = async () => ({ ok: true, status: 200, json: async () => arrayPayload });
const arrayResult = await m.fetchPriceCatalog({ fetchImpl: fakeFetch });
assert.equal(arrayResult.ok, true);
assert.equal(arrayResult.entries.length, 2, "empty key and negative rate are dropped");
assert.deepEqual(arrayResult.entries.map((e) => e.key), ["a/model", "b/model"], "sorted by key");

const mapPayload = {
  "c/model": { input_cost_per_token: 0.000003, output_cost_per_token: 0.000015,
    cache_read_input_token_cost: 0.0000003, cache_creation_input_token_cost: 0.000001 },
};
const mapResult = await m.fetchPriceCatalog({
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: mapPayload }) }),
});
assert.equal(mapResult.ok, true);
assert.equal(mapResult.entries[0].key, "c/model");

for (const broken of [
  async () => { throw new Error("network down"); },
  async () => ({ ok: false, status: 503, json: async () => ({}) }),
  async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } }),
]) {
  const result = await m.fetchPriceCatalog({ fetchImpl: broken });
  assert.equal(result.ok, false, "a failed source degrades instead of throwing");
  assert.deepEqual(result.entries, []);
  assert.equal(typeof result.error, "string");
}

const existing = { "a/model": { input: 9, cacheRead: 9, cacheWrite: 9, output: 9, peakProfile: "std" } };
const merged = m.mergePriceRows(existing, arrayResult.entries);
assert.equal(merged["a/model"].input, 9, "onlyMissing preserves the manual row");
assert.equal(merged["b/model"].input, 2, "a missing key is added");
assert.equal(existing["a/model"].input, 9, "the input object is never mutated");
const overwritten = m.mergePriceRows(existing, arrayResult.entries, { onlyMissing: false });
assert.equal(overwritten["a/model"].input, 1, "onlyMissing=false overwrites");
assert.deepEqual(m.priceSyncSummary(existing, arrayResult.entries),
  { total: 2, added: 1, updated: 1, skipped: 0 });

console.log("price-sync ok: normalize, sort, degrade, merge, summary");
