
/**
 * The P2 collection layer: an event-level fold answering the questions the
 * billable slot rows cannot - how long the model spent streaming, how often a
 * tool failed, and how close each prompt came to the model's context window.
 *
 * Slots stay a stable wire format of their own (one row per hour per model),
 * so this fold is deliberately separate. It is bucketed by local day rather
 * than local hour, because latency and pressure are daily questions. Every
 * counter lives twice: once under the day it happened, and once in "totals",
 * which is always recomputed from the days rather than accumulated
 * independently - a merged fold and a freshly folded slice can therefore never
 * drift apart.
 *
 * The event shapes below were decoded from real session logs. They are read
 * tolerantly: a missing field is a zero, a malformed one is ignored, and no
 * event is allowed to throw. The fold runs on every committed event of every
 * session, so a single surprising record must not stop a whole scan.
 */

import { count, pad2, wallClock } from "./time.js";

/**
 * The numeric keys of one day, in the exact order the serialized rows use.
 *
 * This array is the single definition of both emptyDay() and the wire column
 * order. The Client reads those columns positionally, so reordering anything
 * here is a breaking change; append only, and bump the state/cache versions.
 */
const DAY_KEYS = [
  "llmCalls",
  "ttftMs",
  "decodeMs",
  "llmMs",
  "outputTokens",
  "toolCalls",
  "toolErrors",
  "toolMs",
  "turns",
  "steps",
  "userMessages",
  "completedTurns",
  "abortedTurns",
  "compactOps",
  "shadowedTokens",
  "maxTtftMs",
  "inputSideTokens",
];

/** Event types that contribute to a day bucket. Anything else is ignored. */
const DAY_EVENTS = new Set([
  "assistant/message",
  "tool/call",
  "tool/result",
  "tool/ptc-dispatch-start",
  "turn/start",
  "turn/end",
  "step/start",
  "user/message",
  "compaction/summary",
]);

/**
 * Pending tool calls, keyed by the metrics object itself.
 *
 * A call and its result are separate events, and the result needs the call's
 * start time. A WeakMap keeps the internal metrics shape to exactly the five
 * documented fields (and out of JSON), while mergeMetrics can still carry the
 * in-flight calls across an appended tail.
 */
const pendingCalls = new WeakMap();

/** @returns true for a plain record (never an array, never null). */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A finite, non-negative number; everything else is zero. */
function num(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/** A positive finite context window, or null when the field is unusable. */
function windowOf(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

/** A tool name from a call event; a missing one is still a call, under a name. */
function toolName(data) {
  const name =
    isRecord(data) && typeof data.name === "string" ? data.name.trim() : "";
  return name === "" ? "unknown" : name;
}

/**
 * One day, with exactly the documented numeric keys, all zero.
 * @returns a fresh day record.
 */
export function emptyDay() {
  const day = {};
  for (const key of DAY_KEYS) day[key] = 0;
  return day;
}

/**
 * The empty fold.
 * @returns a fresh internal metrics object.
 */
export function emptyMetrics() {
  return {
    window: null,
    days: {},
    tools: {},
    pressure: [],
    totals: emptyDay(),
  };
}

/** Repair an untrusted metrics object enough that folding cannot throw. */
function ensureShape(metrics) {
  if (!isRecord(metrics.days)) metrics.days = {};
  if (!isRecord(metrics.tools)) metrics.tools = {};
  if (!Array.isArray(metrics.pressure)) metrics.pressure = [];
  if (!isRecord(metrics.totals)) metrics.totals = emptyDay();
  for (const key of DAY_KEYS)
    if (
      typeof metrics.totals[key] !== "number" ||
      !Number.isFinite(metrics.totals[key])
    )
      metrics.totals[key] = 0;
  if (!windowOf(metrics.window)) metrics.window = null;
  return metrics;
}

/** The local-day key of one instant, in the configured zone. */
function dayKey(at, timeZone) {
  try {
    const clock = wallClock(at, timeZone);
    return (
      String(clock.year) +
      "-" +
      pad2(clock.month) +
      "-" +
      pad2(clock.day)
    );
  } catch {
    // A zone the formatter cannot handle must not lose the event: UTC is still
    // a deterministic bucket. This guards even more hostile inputs.
    const fallback = new Date(at);
    return (
      String(fallback.getUTCFullYear()) +
      "-" +
      pad2(fallback.getUTCMonth() + 1) +
      "-" +
      pad2(fallback.getUTCDate())
    );
  }
}

/** The (created on demand) day bucket for one instant. */
function dayFor(metrics, at, timeZone) {
  const key = dayKey(at, timeZone);
  let day = metrics.days[key];
  if (!isRecord(day)) {
    day = emptyDay();
    metrics.days[key] = day;
    return day;
  }
  for (const field of DAY_KEYS)
    if (typeof day[field] !== "number" || !Number.isFinite(day[field]))
      day[field] = 0;
  return day;
}

/** The (created on demand) per-tool counter. */
function toolFor(metrics, name) {
  let tool = metrics.tools[name];
  if (!isRecord(tool)) {
    tool = { calls: 0, errors: 0, ms: 0 };
    metrics.tools[name] = tool;
  }
  for (const field of ["calls", "errors", "ms"])
    if (typeof tool[field] !== "number" || !Number.isFinite(tool[field]))
      tool[field] = 0;
  return tool;
}

/** Add to a day counter and keep the totals in step. */
function add(metrics, day, key, amount) {
  if (!Number.isFinite(amount) || amount === 0) return;
  day[key] += amount;
  metrics.totals[key] += amount;
}

/** Raise a day's maximum and the totals' maximum at once. */
function maximize(metrics, day, key, value) {
  if (!Number.isFinite(value) || value <= 0) return;
  if (value > day[key]) day[key] = value;
  if (value > metrics.totals[key]) metrics.totals[key] = value;
}

/** Recompute totals from the days; the days are the only source of truth. */
function recomputeTotals(metrics) {
  const totals = emptyDay();
  for (const day of Object.values(metrics.days)) {
    if (!isRecord(day)) continue;
    for (const key of DAY_KEYS) {
      const value = num(day[key]);
      if (key === "maxTtftMs") totals[key] = Math.max(totals[key], value);
      else totals[key] += value;
    }
  }
  metrics.totals = totals;
}

/** Sort pressure rows by time and let the later row win an equal timestamp. */
function dedupePressure(rows) {
  rows.sort((left, right) => left[0] - right[0]);
  const out = [];
  for (const row of rows) {
    if (out.length > 0 && out[out.length - 1][0] === row[0])
      out[out.length - 1] = row;
    else out.push(row);
  }
  return out;
}

/** Append one pressure reading, with the equal-time "later wins" rule. */
function pushPressure(metrics, at, inputSideTokens, window) {
  const row = [at, inputSideTokens, windowOf(window)];
  const list = metrics.pressure;
  if (list.length > 0 && list[list.length - 1][0] === at)
    list[list.length - 1] = row;
  else list.push(row);
}

/**
 * Decode the three timing facts from one assistant message's stream.
 *
 * A stream opens with a "chunk" carrying "block-start", then interleaves
 * "reasoning-chunks" / "tool-call-chunks" items (time0, dt[]) with further
 * "chunk" items, and closes on a "block-end" chunk. The model's wall time is
 * the span between the first and last chunk, time-to-first-token is the first
 * emitting item's time0 minus the first chunk's time, and decode time is the
 * sum of every dt array. Negatives and non-finite values clamp to zero.
 * @param stream - the untrusted data.stream value.
 * @returns ttftMs, decodeMs and llmMs.
 */
function streamStats(stream) {
  const empty = { ttftMs: 0, decodeMs: 0, llmMs: 0 };
  if (!Array.isArray(stream)) return empty;
  let firstChunk = null;
  let lastChunk = null;
  let firstEmit = null;
  let decode = 0;
  for (const item of stream) {
    if (!isRecord(item)) continue;
    if (item.type === "chunk") {
      if (typeof item.time === "number" && Number.isFinite(item.time)) {
        if (firstChunk === null) firstChunk = item.time;
        lastChunk = item.time;
      }
      continue;
    }
    if (item.type !== "reasoning-chunks" && item.type !== "tool-call-chunks")
      continue;
    if (
      firstEmit === null &&
      typeof item.time0 === "number" &&
      Number.isFinite(item.time0)
    )
      firstEmit = item.time0;
    if (Array.isArray(item.dt)) for (const delta of item.dt) decode += num(delta);
  }
  if (firstChunk === null || lastChunk === null)
    return { ttftMs: 0, decodeMs: decode, llmMs: 0 };
  return {
    ttftMs: firstEmit === null ? 0 : num(firstEmit - firstChunk),
    decodeMs: decode,
    llmMs: num(lastChunk - firstChunk),
  };
}

/** The in-flight call map for one metrics object. */
function callsFor(metrics) {
  let calls = pendingCalls.get(metrics);
  if (calls === undefined) {
    calls = new Map();
    pendingCalls.set(metrics, calls);
  }
  return calls;
}

/**
 * Fold ONE event into an existing metrics object, in place.
 *
 * This is the single-event kernel: foldMetrics folds a slice with it and the
 * Host's live projection calls it for every committed event. Nothing here
 * throws, and a missing field is always a zero.
 * @param metrics - the internal fold to mutate.
 * @param event - one committed session event.
 * @param timeZone - IANA zone that decides the local day.
 * @returns the same metrics object.
 */
export function foldMetricsInto(metrics, event, timeZone) {
  if (!isRecord(metrics)) return metrics;
  ensureShape(metrics);
  if (!isRecord(event) || typeof event.type !== "string") return metrics;
  const data = event.data;

  // The window is global to the fold, not a day counter: a request/context
  // event only moves it, so handle it before a day bucket is touched.
  if (event.type === "request/context") {
    if (isRecord(data)) {
      const next = windowOf(data.contextWindow);
      if (next !== null) metrics.window = next;
    }
    return metrics;
  }
  if (!DAY_EVENTS.has(event.type)) return metrics;

  const at =
    typeof event.time === "number" &&
    Number.isFinite(event.time) &&
    Math.abs(event.time) < 8.64e15
      ? event.time
      : Date.now();
  // Lazily created: an event that contributes nothing (a tool result with no
  // matching call, say) must not leave an all-zero day behind.
  let day = null;
  const bucket = () =>
    day === null ? (day = dayFor(metrics, at, timeZone)) : day;

  switch (event.type) {
    case "assistant/message": {
      const usage = isRecord(data) ? data.usage : undefined;
      if (!isRecord(usage)) break;
      const inputSide =
        num(usage.inputTokens) +
        num(usage.cacheReadTokens) +
        num(usage.cacheWriteTokens);
      const stats = streamStats(isRecord(data) ? data.stream : undefined);
      const target = bucket();
      add(metrics, target, "llmCalls", 1);
      add(metrics, target, "outputTokens", num(usage.outputTokens));
      add(metrics, target, "inputSideTokens", inputSide);
      add(metrics, target, "ttftMs", stats.ttftMs);
      add(metrics, target, "decodeMs", stats.decodeMs);
      add(metrics, target, "llmMs", stats.llmMs);
      maximize(metrics, target, "maxTtftMs", stats.ttftMs);
      pushPressure(
        metrics,
        at,
        inputSide,
        metrics.window,
      );
      break;
    }
    case "tool/call": {
      const name = toolName(data);
      add(metrics, bucket(), "toolCalls", 1);
      toolFor(metrics, name).calls += 1;
      const callId = isRecord(data) ? data.callId : undefined;
      if (typeof callId === "string" && callId !== "")
        callsFor(metrics).set(callId, {
          time: at,
          day: dayKey(at, timeZone),
          name,
        });
      break;
    }
    case "tool/result": {
      const message = isRecord(data) ? data.message : undefined;
      const primary = isRecord(message) ? message.toolCallId : undefined;
      const fallback = isRecord(data) ? data.toolCallId : undefined;
      const callId =
        typeof primary === "string" && primary !== ""
          ? primary
          : typeof fallback === "string" && fallback !== ""
            ? fallback
            : undefined;
      if (callId === undefined) break;
      const calls = callsFor(metrics);
      const call = calls.get(callId);
      if (call === undefined) break;
      const ms = num(at - call.time);
      // Attribute the duration to the day the call started: a tool that ran
      // across midnight belongs to one day, not two.
      const target = dayFor(metrics, call.time, timeZone);
      add(metrics, target, "toolMs", ms);
      toolFor(metrics, call.name).ms += ms;
      if (isRecord(message) && message.isError === true) {
        add(metrics, target, "toolErrors", 1);
        toolFor(metrics, call.name).errors += 1;
      }
      calls.delete(callId);
      break;
    }
    case "tool/ptc-dispatch-start": {
      // A dispatched sub-call is a tool call by name, but has no result event
      // of its own and therefore no duration.
      add(metrics, bucket(), "toolCalls", 1);
      toolFor(metrics, toolName(data)).calls += 1;
      break;
    }
    case "turn/start":
      add(metrics, bucket(), "turns", 1);
      break;
    case "turn/end": {
      const kind =
        isRecord(data) && isRecord(data.reason) ? data.reason.kind : undefined;
      add(
        metrics,
        bucket(),
        kind === "completed" ? "completedTurns" : "abortedTurns",
        1,
      );
      break;
    }
    case "step/start":
      add(metrics, bucket(), "steps", 1);
      break;
    case "user/message":
      add(metrics, bucket(), "userMessages", 1);
      break;
    case "compaction/summary": {
      const target = bucket();
      add(metrics, target, "compactOps", 1);
      add(
        metrics,
        target,
        "shadowedTokens",
        count(isRecord(data) ? data.shadowedTokenCount : 0),
      );
      break;
    }
    default:
      break;
  }
  return metrics;
}

/**
 * Fold an event slice into a fresh metrics object.
 * @param events - the events to fold; a non-array folds to empty.
 * @param timeZone - IANA zone that decides the local day.
 * @returns the same shape as emptyMetrics().
 */
export function foldMetrics(events, timeZone) {
  const metrics = emptyMetrics();
  if (!Array.isArray(events)) return metrics;
  for (const event of events) foldMetricsInto(metrics, event, timeZone);
  metrics.pressure = dedupePressure(metrics.pressure);
  recomputeTotals(metrics);
  return metrics;
}

/**
 * Combine two folds into a fresh one.
 *
 * Days and tools sum by key, maxTtftMs takes the maximum, and pressure rows
 * are appended, sorted and deduplicated by time (the later row wins). The
 * window prefers "added" and falls back to "existing". Totals are recomputed
 * from the merged days rather than added, so they cannot inherit a drift.
 * @param existing - the fold built so far; null/undefined is an empty fold.
 * @param added - the fold to add.
 * @returns a fresh combined fold.
 */
export function mergeMetrics(existing, added) {
  // Capture the in-flight calls before normalizing: deserializeMetrics returns
  // fresh objects, which have no WeakMap entry of their own.
  const leftCalls = isRecord(existing) ? pendingCalls.get(existing) : undefined;
  const rightCalls = isRecord(added) ? pendingCalls.get(added) : undefined;
  const left = deserializeMetrics(existing);
  const right = deserializeMetrics(added);
  const result = emptyMetrics();

  result.window = right.window ?? left.window;

  const days = new Set([...Object.keys(left.days), ...Object.keys(right.days)]);
  for (const key of days) {
    const a = left.days[key];
    const b = right.days[key];
    if (a === undefined) {
      result.days[key] = { ...b };
      continue;
    }
    if (b === undefined) {
      result.days[key] = { ...a };
      continue;
    }
    const day = emptyDay();
    for (const field of DAY_KEYS)
      day[field] =
        field === "maxTtftMs"
          ? Math.max(a[field], b[field])
          : a[field] + b[field];
    result.days[key] = day;
  }

  const names = new Set([
    ...Object.keys(left.tools),
    ...Object.keys(right.tools),
  ]);
  for (const name of names) {
    const a = left.tools[name] ?? { calls: 0, errors: 0, ms: 0 };
    const b = right.tools[name] ?? { calls: 0, errors: 0, ms: 0 };
    result.tools[name] = {
      calls: a.calls + b.calls,
      errors: a.errors + b.errors,
      ms: a.ms + b.ms,
    };
  }

  result.pressure = dedupePressure([...left.pressure, ...right.pressure]);
  recomputeTotals(result);

  const carried = new Map();
  if (leftCalls)
    for (const [id, info] of leftCalls) carried.set(id, info);
  if (rightCalls)
    for (const [id, info] of rightCalls) carried.set(id, info);
  if (carried.size > 0) pendingCalls.set(result, carried);
  return result;
}

/**
 * Render a fold for the wire.
 *
 * The Client reads these columns positionally, so the order is a contract:
 * days rows are [day, llmCalls, ttftMs, decodeMs, llmMs, outputTokens,
 * toolCalls, toolErrors, toolMs, turns, steps, userMessages, completedTurns,
 * abortedTurns, compactOps, shadowedTokens, maxTtftMs, inputSideTokens].
 * tools rows are [name, calls, errors, ms], sorted by calls descending;
 * pressure rows are [time, inputSideTokens, contextWindow], capped to the
 * most recent 500. Only plain JSON values are emitted.
 * @param metrics - an internal (or already serialized) fold.
 * @returns a plain JSON-safe object.
 */
export function serializeMetrics(metrics) {
  const internal = deserializeMetrics(metrics);
  const days = Object.keys(internal.days)
    .sort()
    .map((day) => {
      const counters = internal.days[day];
      return [day, ...DAY_KEYS.map((key) => counters[key])];
    });
  const tools = Object.entries(internal.tools)
    .map(([name, tool]) => [name, tool.calls, tool.errors, tool.ms])
    .sort((left, right) =>
      right[1] === left[1]
        ? left[0] < right[0]
          ? -1
          : left[0] > right[0]
            ? 1
            : 0
        : right[1] - left[1],
    );
  const pressure = internal.pressure
    .slice(-500)
    .map((row) => [row[0], row[1], row[2]]);
  return {
    window: internal.window,
    days,
    tools,
    pressure,
    totals: { ...internal.totals },
  };
}

/**
 * Rebuild the internal shape from a serialized fold.
 *
 * Tolerant by design: the Host checkpoints the projection state as
 * structured-clone-ish data and an older row may carry either the serialized
 * columns or an already-internal fold. Both are accepted, every value is
 * validated, and totals are always recomputed from the days. Bad input yields
 * an empty fold rather than a partial one.
 * @param value - the value read from the wire, cache or projection row.
 * @returns a fresh internal metrics object.
 */
export function deserializeMetrics(value) {
  const metrics = emptyMetrics();
  if (!isRecord(value)) return metrics;

  metrics.window = windowOf(value.window);

  if (Array.isArray(value.days)) {
    for (const row of value.days) {
      if (!Array.isArray(row) || typeof row[0] !== "string" || row[0] === "")
        continue;
      const day = emptyDay();
      for (let index = 0; index < DAY_KEYS.length; index += 1)
        day[DAY_KEYS[index]] = num(row[index + 1]);
      metrics.days[row[0]] = day;
    }
  } else if (isRecord(value.days)) {
    for (const [key, raw] of Object.entries(value.days)) {
      if (key === "" || !isRecord(raw)) continue;
      const day = emptyDay();
      for (const field of DAY_KEYS) day[field] = num(raw[field]);
      metrics.days[key] = day;
    }
  }

  const putTool = (name, calls, errors, ms) => {
    if (typeof name !== "string" || name === "") return;
    const tool = toolFor(metrics, name);
    tool.calls += calls;
    tool.errors += errors;
    tool.ms += ms;
  };
  if (Array.isArray(value.tools)) {
    for (const row of value.tools) {
      if (!Array.isArray(row)) continue;
      putTool(row[0], num(row[1]), num(row[2]), num(row[3]));
    }
  } else if (isRecord(value.tools)) {
    for (const [name, raw] of Object.entries(value.tools)) {
      if (!isRecord(raw)) continue;
      putTool(name, num(raw.calls), num(raw.errors), num(raw.ms));
    }
  }

  if (Array.isArray(value.pressure)) {
    for (const row of value.pressure) {
      if (
        !Array.isArray(row) ||
        typeof row[0] !== "number" ||
        !Number.isFinite(row[0])
      )
        continue;
      metrics.pressure.push([row[0], num(row[1]), windowOf(row[2])]);
    }
    metrics.pressure = dedupePressure(metrics.pressure);
  }

  // "totals" is never trusted: the days are the source of truth.
  recomputeTotals(metrics);
  return metrics;
}
