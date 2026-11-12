/**
 * The P2 collection layer's regression pins.
 *
 * Every event below is synthesized in the schema decoded from real session
 * logs: stream chunks, tool results with isError on data.message, and the
 * request/context window. The numbers are hand-computed so a change to the
 * fold's arithmetic - not just its ability to run - fails the suite.
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const load = (relative) => import(pathToFileURL(join(root, relative)).href);

const {
  emptyDay,
  emptyMetrics,
  foldMetrics,
  foldMetricsInto,
  mergeMetrics,
  serializeMetrics,
  deserializeMetrics,
} = await load("lib/metrics.js");
const { foldEventsWithMetrics } = await load("lib/scan.js");

const ZONE = "Asia/Shanghai";
const T0 = Date.parse("2026-11-03T02:00:00Z"); // 2026-11-03 10:00 in zone
const T1 = T0 + 86_400_000; // the next local day

let seq = 0;
const ev = (type, time, data) => ({ type, seq: seq++, time, data });

/** One assistant message with a real-shaped usage block and stream. */
const llm = (time, usage, stream) =>
  ev("assistant/message", time, {
    turn: 1,
    step: 2,
    message: { role: "assistant", source: { kind: "model", provider: "p", model: "m" } },
    usage,
    stream,
  });

const streamOf = (base, emitAt, dt, endAt) => [
  { type: "chunk", time: base, chunk: { type: "block-start", index: 0, blockType: "text" } },
  { type: "reasoning-chunks", time0: emitAt, index: 0, dt },
  { type: "chunk", time: endAt, chunk: { type: "block-end", index: 0 } },
];

const events = [
  ev("request/context", T0, { provider: "p", model: "m", contextWindow: 128000 }),
  // --- assistant messages -------------------------------------------------
  llm(
    T0 + 1000,
    {
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
    },
    [
      { type: "chunk", time: T0 + 1000, chunk: { type: "block-start", index: 0, blockType: "text" } },
      { type: "reasoning-chunks", time0: T0 + 1200, index: 0, dt: [50, 60] },
      { type: "tool-call-chunks", time0: T0 + 1500, index: 1, dt: [100, 200] },
      { type: "chunk", time: T0 + 2000, chunk: { type: "block-end", index: 0 } },
    ],
  ),
  llm(
    T0 + 5000,
    { inputTokens: 200, outputTokens: 30, totalTokens: 230 },
    streamOf(T0 + 5000, T0 + 5300, [10], T0 + 5600),
  ),
  // --- tool calls and results --------------------------------------------
  ev("tool/call", T0 + 6000, { turn: 1, step: 2, callId: "c1", name: "read_file", arguments: {} }),
  ev("tool/result", T0 + 6500, {
    turn: 1,
    step: 2,
    message: { role: "tool", source: "read_file", toolCallId: "c1", content: "ok", isError: false, id: "r1" },
  }),
  ev("tool/call", T0 + 7000, { turn: 1, step: 2, callId: "c2", name: "run_bash", arguments: {} }),
  ev("tool/result", T0 + 7600, {
    turn: 1,
    step: 2,
    message: { role: "tool", source: "run_bash", toolCallId: "c2", content: "boom", isError: true, id: "r2" },
  }),
  ev("tool/ptc-dispatch-start", T0 + 8000, {
    rootCallId: "c0",
    parentCallId: "c1",
    subCallId: "c3",
    name: "sub_tool",
    arguments: {},
  }),
  // --- turns, steps, messages ---------------------------------------------
  ev("turn/start", T0 + 9000, { turn: 1 }),
  ev("step/start", T0 + 9100, { turn: 1, step: 1 }),
  ev("step/start", T0 + 9200, { turn: 1, step: 2 }),
  ev("turn/end", T0 + 9300, { turn: 1, reason: { kind: "completed" } }),
  ev("turn/start", T0 + 10000, { turn: 2 }),
  ev("turn/end", T0 + 10100, { turn: 2, reason: { kind: "aborted" } }),
  ev("user/message", T0 + 11000, { content: "hello" }),
  ev("user/message", T0 + 11100, { message: "again" }),
  // --- compaction ---------------------------------------------------------
  ev("compaction/summary", T0 + 12000, { compactionId: "k1", shadowedTokenCount: 5000, shadowedSeqs: [] }),
  ev("compaction/summary", T0 + 12100, { compactionId: "k2", shadowedTokenCount: 2500 }),
  ev("compaction/start", T0 + 12200, { compactionId: "k1" }),
  ev("compaction/end", T0 + 12300, { compactionId: "k1" }),
  // --- ignored types ------------------------------------------------------
  ev("system/message", T0 + 12400, { content: "sys" }),
  ev("session/title", T0 + 12500, { title: "named" }),
  ev("something/else", T0 + 12600, { anything: true }),
  // --- a second local day, to pin the wall-clock bucketing ----------------
  ev("user/message", T1 + 1000, { content: "next day" }),
];

// (a) exact hand-computed numbers.
const m = foldMetrics(events, ZONE);
assert.deepEqual(Object.keys(m.days).sort(), ["2026-11-03", "2026-11-04"]);
const d = m.days["2026-11-03"];
assert.equal(d.llmCalls, 2, "one llmCall per assistant message with usage");
assert.equal(d.ttftMs, 500, "200 + 300 ms to first token");
assert.equal(d.decodeMs, 420, "50+60+100+200 + 10 ms of dt arrays");
assert.equal(d.llmMs, 1600, "1000 + 600 ms of stream wall time");
assert.equal(d.outputTokens, 55, "25 + 30 output tokens");
assert.equal(d.inputSideTokens, 350, "input + cacheRead + cacheWrite");
assert.equal(d.maxTtftMs, 300, "the larger of the two TTFTs");
assert.equal(d.toolCalls, 3, "two tool/call plus one ptc dispatch");
assert.equal(d.toolErrors, 1, "isError at data.message.isError is counted");
assert.equal(d.toolMs, 1100, "500 + 600 ms of matched tool durations");
assert.equal(d.turns, 2);
assert.equal(d.steps, 2);
assert.equal(d.userMessages, 2);
assert.equal(d.completedTurns, 1);
assert.equal(d.abortedTurns, 1);
assert.equal(d.compactOps, 2);
assert.equal(d.shadowedTokens, 7500);
assert.equal(m.window, 128000, "the most recent request/context window");
assert.deepEqual(m.pressure, [
  [T0 + 1000, 150, 128000],
  [T0 + 5000, 200, 128000],
]);
assert.deepEqual(m.tools, {
  read_file: { calls: 1, errors: 0, ms: 500 },
  run_bash: { calls: 1, errors: 1, ms: 600 },
  sub_tool: { calls: 1, errors: 0, ms: 0 },
});
assert.equal(m.totals.userMessages, 3, "totals sum every day's counters");
assert.equal(m.totals.llmCalls, 2);
assert.equal(m.totals.maxTtftMs, 300, "totals take the max of maxTtftMs");
assert.deepEqual(m.totals, {
  llmCalls: 2,
  ttftMs: 500,
  decodeMs: 420,
  llmMs: 1600,
  outputTokens: 55,
  toolCalls: 3,
  toolErrors: 1,
  toolMs: 1100,
  turns: 2,
  steps: 2,
  userMessages: 3,
  completedTurns: 1,
  abortedTurns: 1,
  compactOps: 2,
  shadowedTokens: 7500,
  maxTtftMs: 300,
  inputSideTokens: 350,
});
assert.deepEqual(Object.keys(emptyDay()).sort(), Object.keys(d).sort(), "emptyDay has exactly the documented keys");

// (b) isError at data.message.isError is counted; data.error must not be.
const onlyErrors = foldMetrics(
  [
    ev("tool/call", T0, { callId: "x", name: "n" }),
    ev("tool/result", T0 + 10, { error: { isError: true }, message: { toolCallId: "x", isError: true } }),
    ev("tool/call", T0 + 20, { callId: "y", name: "n" }),
    ev("tool/result", T0 + 30, { error: { isError: true }, message: { toolCallId: "y", isError: false } }),
  ],
  ZONE,
);
assert.equal(onlyErrors.totals.toolErrors, 1, "only data.message.isError === true counts");
assert.equal(onlyErrors.totals.toolMs, 20, "both matched results contribute duration");

// (c) mergeMetrics sums days/tools and takes max for maxTtftMs.
const a = foldMetrics(
  [llm(T0, { inputTokens: 10, outputTokens: 1 }, streamOf(T0, T0 + 100, [5], T0 + 400)),
   ev("tool/call", T0 + 500, { callId: "q", name: "n" })],
  ZONE,
);
const b = foldMetrics(
  [llm(T1, { inputTokens: 20, outputTokens: 2 }, streamOf(T1, T1 + 700, [7], T1 + 900)),
   ev("tool/call", T1 + 1000, { callId: "r", name: "n" }),
   ev("tool/result", T1 + 1050, { message: { toolCallId: "r", isError: true } })],
  ZONE,
);
const merged = mergeMetrics(a, b);
assert.equal(merged.totals.llmCalls, 2);
assert.equal(merged.totals.maxTtftMs, 700, "maxTtftMs takes the maximum, not the sum (would be 800)");
assert.equal(merged.totals.ttftMs, 800, "the other timing fields still sum");
assert.equal(merged.totals.toolCalls, 2, "one tool/call in each fold sums to two");
assert.equal(merged.totals.toolErrors, 1);
assert.equal(merged.tools.n.calls, 2);
assert.equal(merged.tools.n.errors, 1);
assert.equal(merged.tools.n.ms, 50);
assert.equal(merged.window, null, "no request/context event in either fold");
assert.deepEqual(Object.keys(merged.days).sort(), ["2026-11-03", "2026-11-04"]);
assert.deepEqual(mergeMetrics(null, a).totals, a.totals, "a null existing fold is an empty fold");
assert.deepEqual(mergeMetrics(a, undefined).totals, a.totals);
// Pressure: equal timestamps dedupe with the later row winning.
const p1 = foldMetrics([llm(T0 + 1, { inputTokens: 1 }, [])], ZONE);
const p2 = foldMetrics([llm(T0 + 1, { inputTokens: 9 }, [])], ZONE);
assert.equal(mergeMetrics(p1, p2).pressure.length, 1, "equal-time pressure rows dedupe");
assert.equal(mergeMetrics(p1, p2).pressure[0][1], 9, "the later row wins");
assert.equal(mergeMetrics(a, b).pressure.length, 2, "distinct times are both kept");
// window prefers "added".
const w1 = foldMetrics([ev("request/context", T0, { contextWindow: 1000 })], ZONE);
const w2 = foldMetrics([ev("request/context", T1, { contextWindow: 2000 })], ZONE);
assert.equal(mergeMetrics(w1, w2).window, 2000);
assert.equal(mergeMetrics(w1, emptyMetrics()).window, 1000, "an empty added fold does not clear the window");

// (d) serialize/deserialize roundtrip preserves the exact column order.
const COLUMN_ORDER = [
  "llmCalls", "ttftMs", "decodeMs", "llmMs", "outputTokens", "toolCalls",
  "toolErrors", "toolMs", "turns", "steps", "userMessages", "completedTurns",
  "abortedTurns", "compactOps", "shadowedTokens", "maxTtftMs", "inputSideTokens",
];
const serial = serializeMetrics(m);
assert.deepEqual(Object.keys(serial), ["window", "days", "tools", "pressure", "totals"]);
assert.equal(serial.window, 128000);
assert.deepEqual(
  serial.days[0],
  ["2026-11-03", 2, 500, 420, 1600, 55, 3, 1, 1100, 2, 2, 2, 1, 1, 2, 7500, 300, 350],
  "the 18-column day row is a positional wire contract",
);
assert.equal(serial.days[0].length, 18);
assert.equal(serial.days.length, 2);
assert.deepEqual(serial.tools[0], ["read_file", 1, 0, 500], "tools sorted by calls desc, then name");
assert.equal(serial.tools.length, 3);
assert.deepEqual(serial.pressure, [[T0 + 1000, 150, 128000], [T0 + 5000, 200, 128000]]);
assert.deepEqual(serial.totals, m.totals);
// Plain JSON safety: nothing but arrays, objects, strings, finite numbers, null.
assert.doesNotThrow(() => JSON.parse(JSON.stringify(serial)));
const rebuilt = deserializeMetrics(JSON.parse(JSON.stringify(serial)));
assert.deepEqual(serializeMetrics(rebuilt), serial, "a JSON roundtrip is lossless");
assert.deepEqual(rebuilt.days["2026-11-03"], d);
assert.deepEqual(rebuilt.tools, m.tools);
assert.deepEqual(rebuilt.pressure, m.pressure);
assert.equal(rebuilt.window, 128000);
// A 500-row pressure cap, and the most recent rows are the ones kept.
const bigPressure = Array.from({ length: 620 }, (_, i) => [T0 + i, i + 1, 128000]);
assert.equal(serializeMetrics({ ...serial, pressure: bigPressure }).pressure.length, 500);
assert.equal(serializeMetrics({ ...serial, pressure: bigPressure }).pressure[499][0], T0 + 619);
// Bad input degrades to an empty fold, never a partial one.
for (const bad of [null, undefined, 0, "x", [], { days: "no" }])
  assert.deepEqual(serializeMetrics(deserializeMetrics(bad)), serializeMetrics(emptyMetrics()), "bad input degrades to an empty fold");
// A valid day key survives hostile counters, but every non-finite value is zeroed.
const zeroed = deserializeMetrics({ days: [["d", NaN, Infinity, -1]] });
assert.deepEqual(zeroed.days.d, emptyDay(), "a damaged day row is zeroed, never NaN or Infinity");
assert.equal(deserializeMetrics({ window: -5 }).window, null);
assert.equal(deserializeMetrics({ window: Infinity }).window, null);

// (e) foldMetrics / foldMetricsInto never throw on null or malformed events.
const hostile = [
  null, undefined, 0, 1, "text", true, [], {},
  { type: 123 },
  { type: "assistant/message" },
  { type: "assistant/message", data: null },
  { type: "assistant/message", data: { usage: {} } },
  { type: "assistant/message", data: { usage: { inputTokens: "x", outputTokens: NaN }, stream: "no" } },
  { type: "assistant/message", time: NaN, data: { usage: { inputTokens: -1 }, stream: [null, 5, { type: "chunk", time: "bad" }, { type: "reasoning-chunks", time0: NaN, dt: [NaN, -3, "z"] }] } },
  { type: "tool/call", data: null },
  { type: "tool/call", data: { callId: 5, name: 5 } },
  { type: "tool/result", data: { message: null } },
  { type: "tool/result", data: { message: { toolCallId: "missing", isError: true } } },
  { type: "tool/ptc-dispatch-start", data: null },
  { type: "turn/end", data: null },
  { type: "turn/end", data: { reason: null } },
  { type: "compaction/summary", data: { shadowedTokenCount: -5 } },
  { type: "request/context", data: { contextWindow: -1 } },
  { type: "request/context", data: { contextWindow: Infinity } },
  { type: "user/message", time: Infinity, data: {} },
  { type: "step/start", time: "bad", data: {} },
];
assert.doesNotThrow(() => foldMetrics(hostile, ZONE));
assert.doesNotThrow(() => foldMetrics(null, ZONE));
assert.doesNotThrow(() => foldMetrics("no", undefined));
assert.doesNotThrow(() => foldMetrics([], "Not/A_Zone"));
const kernel = emptyMetrics();
for (const bad of hostile) assert.doesNotThrow(() => foldMetricsInto(kernel, bad, ZONE));
assert.deepEqual(serializeMetrics(foldMetrics([], ZONE)), serializeMetrics(emptyMetrics()));
// Negatives and non-finite timings clamp to zero.
const clamped = foldMetrics([llm(T0, { inputTokens: 1 }, [
  { type: "chunk", time: T0, chunk: { type: "block-start" } },
  { type: "reasoning-chunks", time0: T0 - 99999, index: 0, dt: [-5, Infinity, NaN] },
  { type: "chunk", time: T0 - 99999, chunk: { type: "block-end" } },
])], ZONE);
assert.equal(clamped.totals.ttftMs, 0);
assert.equal(clamped.totals.llmMs, 0);
assert.equal(clamped.totals.decodeMs, 0);

// (f) foldEventsWithMetrics keeps every slot row at exactly 8 columns.
const withMetrics = foldEventsWithMetrics(events, ZONE);
assert.ok(withMetrics.metrics.days !== undefined);
for (const row of withMetrics.slots)
  assert.equal(row.length, 8, "the stable slot wire format is untouched");
assert.equal(withMetrics.slots.length, 1);
assert.deepEqual(withMetrics.slots[0], ["2026-11-03T10", "p/m", 300, 55, 40, 10, 355, 2], "totalTokens wins over the component sum in foldEvents");

console.log("metrics ok: real-schema fold, isError, merge, roundtrip, hostile events, 8-column slots");
