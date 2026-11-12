/**
 * Boot regression guard.
 *
 * node --check only proves syntax. Two failures that killed the Web boot in
 * 1.1.0 were evaluation-time, not syntax errors:
 *   - `const JA = { ...EN }` appeared BEFORE `const EN = {...}`, so the
 *     factory threw a temporal-dead-zone ReferenceError while the module was
 *     being evaluated;
 *   - index.js used a top-level `await`, which is not safe for a loader that
 *     may evaluate the entry as a classic script.
 * This test evaluates BOTH entry points the way a loader would, so either
 * regression fails here instead of at "web boot: 1 entry did not activate".
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const client = readFileSync(join(root, "client.js"), "utf8");
const index = readFileSync(join(root, "index.js"), "utf8");

// 1. Declaration order: a spread override dictionary must follow its base.
const order = ["ZH", "EN", "JA"].map((name) => ({
  name,
  at: client.indexOf("const " + name + " = {"),
}));
for (const entry of order) assert.notEqual(entry.at, -1, entry.name + " dictionary missing");
assert.ok(order[0].at < order[1].at, "ZH must be declared before EN");
assert.ok(order[1].at < order[2].at, "EN must be declared before JA (JA spreads EN)");

// 2. No top-level await in the Host entry: every await must sit inside a
//    function body. A crude but effective check for the exact regression.
assert.doesNotMatch(index, /^const \w+ = await /m, "index.js must not use top-level await");

// Sparklines stretch a 100x32 viewBox to the card width. Without a
// non-scaling stroke the line width follows the stretch, so steep segments
// (a cost spike) look thicker than flat ones. Both sparklines must opt out.
const strokeCount = (client.match(/vectorEffect: "non-scaling-stroke"/g) ?? []).length;
assert.equal(strokeCount, 2, "both sparklines must use a constant-width stroke");
const svgCount = (client.match(/preserveAspectRatio: "none"/g) ?? []).length;
assert.ok(svgCount >= 2, "the two sparkline SVGs still use the stretched viewBox");

// 3. Evaluate the client factory with a permissive require stub. Any TDZ,
//    undefined binding or bad spread at module-evaluation time surfaces here.
const noop = () => () => {};
const stub = new Proxy({}, { get: (_t, name) => (name === "__esModule" ? false : name) });
let factoryError = null;
const sandbox = {
  window: { __ModuleLoader__: { load(spec) { try { spec.factory(() => stub); } catch (e) { factoryError = e; } } } },
  document: { createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }), body: { appendChild() {}, removeChild() {} }, addEventListener() {}, removeEventListener() {} },
  navigator: {},
  Intl, Date, Math, JSON, Number, String, Array, Object, Map, Set, WeakMap, Promise, RegExp, Boolean, Error,
  console, setTimeout, clearTimeout, setInterval, clearInterval, fetch: async () => ({ ok: false }),
  AbortSignal, AbortController, URL, URLSearchParams, TextEncoder, TextDecoder,
  ResizeObserver: class { observe() {} disconnect() {} },
};
sandbox.globalThis = sandbox;
vm.runInNewContext(client, sandbox, { filename: "client.js", timeout: 15000 });
assert.equal(factoryError, null,
  "client.js factory threw at evaluation: " + String(factoryError?.message ?? ""));

// 4. Import the Host entry and run apply() with a minimal context.
const host = await import(pathToFileURL(join(root, "index.js")).href);
const ctx = {
  get: () => undefined, inject: () => {}, on: () => {},
  effect: (fn) => { try { fn(); } catch {} return noop; },
  logger: { warn: noop, info: noop },
  settings: { describe: () => ({}) },
  webServer: { register: () => noop },
  slots: { register: () => noop },
  locale: { register: () => noop, bind: () => (k) => k },
};
assert.doesNotThrow(() => host.apply(ctx, {}), "Host apply() must not throw at registration");

console.log("boot ok: dictionary order, no top-level await, client factory, host apply");
