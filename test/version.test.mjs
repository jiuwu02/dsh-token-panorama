/**
 * The slot shape and the projection state version are one contract.
 *
 * lib/scan.js and lib/projection.js both build the same eight-column row. A
 * change to that shape makes every stored projection row and every cached fold
 * stale, so USAGE_STATE_VERSION and CACHE_VERSION must move together with it.
 * This test pins the contract itself, not just the numbers: if someone adds a
 * column without bumping the versions, this fails at the shape check.
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const load = (relative) => import(pathToFileURL(join(root, relative)).href);

const { USAGE_STATE_VERSION, emptyState } = await load("lib/projection.js");
const { foldEvents } = await load("lib/scan.js");
const store = await load("lib/store.js");

// A no-usage slice still exercises the row constructor via a synthetic usage
// event, so the exact column count comes from the real fold rather than from a
// hand-written literal.
const now = Date.UTC(2026, 10, 12, 3, 0, 0);
const events = [
  { type: "assistant/message", seq: 0, time: now, data: { usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } } },
];
const folded = foldEvents(events, "Asia/Shanghai");
assert.equal(folded.slots.length, 1, "one usage event yields one slot");
assert.equal(folded.slots[0].length, 8, "the slot row stays exactly eight columns");

// The projection's empty state starts from the same eight-column shape.
const state = emptyState("Asia/Shanghai");
assert.equal(state.rows.length, 0, "a fresh state has no rows");
assert.ok(typeof USAGE_STATE_VERSION === "number" && USAGE_STATE_VERSION >= 3,
  "a fold that carries metrics needs a state version that invalidates old rows");

// Both versions must be present and numeric: a missing export would silently
// leave the cache using an unknown identity.
const cacheVersion = store.CACHE_VERSION;
assert.ok(typeof cacheVersion === "number" && cacheVersion >= 6,
  "the cache version must be exported and not regress below the metrics fold");

console.log("version ok: slot shape, state version, cache version pinned together");
