/**
 * The durable usage fold, contributed to the Host's projection registry.
 *
 * The panel's cache can be thrown away — a version bump, a corrupt file, a
 * deleted profile — and rebuilding it means inflating every stored log. The
 * Host already runs a registry that folds every committed session event once,
 * while the events are still in memory, and a companion service persists those
 * states to disk. Contributing the same fold here makes the work survive the
 * panel's own cache: a scan can seed from a session's stored projection and
 * only read the frames appended after its watermark, and a session the Host
 * has just written needs no log read at all.
 *
 * The unit's state is deliberately the panel's own slot shape rather than a
 * second model of the same numbers: one definition of billable usage means a
 * seeded fold and a freshly folded one can never disagree about what a row
 * means.
 */

import { count } from "./time.js";
import { billingKeyOf } from "./route.js";
import {
  deserializeMetrics,
  emptyMetrics,
  foldMetricsInto,
  serializeMetrics,
} from "./metrics.js";

/**
 * The registry key this plugin owns.
 *
 * Named for the plugin rather than for "usage" so it cannot be confused with
 * the token meter's own totals unit, which folds the same events into a
 * different shape.
 */
export const USAGE_PROJECTION_KEY = "tokenPanoramaUsage";

/**
 * The unit's state version.
 *
 * Bumping this invalidates every stored row, which forces a full refold on the
 * next scan — exactly the re-read a changed fold definition requires.
 */
export const USAGE_STATE_VERSION = 3;

/**
 * The empty state: no title, no rows, and the zone the hours are keyed in.
 *
 * The zone travels with the state because a row is only usable by a fold that
 * buckets hours the same way: the same event lands in one hour under UTC and
 * in another under a zone that is not a whole number of hours away.
 * @param zone - the IANA zone the hour keys are bucketed in.
 * @returns a fresh state object.
 */
export function emptyState(zone) {
  return {
    zone: typeof zone === "string" ? zone : "",
    title: "",
    rows: [],
    // P2: the live state keeps the internal event-level fold; wire.view
    // serializes it at the checkpoint boundary (see the comment there).
    metrics: emptyMetrics(),
  };
}

/**
 * Fold one event into the state.
 *
 * The same reference is returned for every event that does not carry usage or
 * a title, so an unrelated event costs one type comparison. Relevant events
 * mutate the state in place: nothing reads this key through the change feed,
 * and avoiding a copy per usage event is what keeps the fold cheap enough to
 * run on every committed event of every session.
 * @param state - the current state.
 * @param event - the committed session event.
 * @param bucketAt - the hour bucketing function for this fold's zone.
 * @returns the state.
 */
export function applyEvent(state, event, bucketAt, timeZone) {
  // The P2 fold sees EVERY committed event, including the ones with no usage
  // and no title. It mutates in place and never copies the state, so the
  // same-reference fast path for irrelevant events is preserved exactly.
  if (state !== null && typeof state === "object")
    state.metrics = applyMetricsEvent(state.metrics, event, timeZone);
  if (event === null || typeof event !== "object") return state;
  if (event.type === "session/title") {
    const text = event.data?.title;
    if (typeof text === "string" && text !== "" && text !== state.title)
      state.title = text;
    return state;
  }
  if (event.type !== "assistant/message") return state;
  const usage = event.data?.usage;
  if (usage === undefined || usage === null) return state;
  const hour = bucketAt(typeof event.time === "number" ? event.time : Date.now());
  if (typeof hour !== "string" || hour === "") return state;
  const model = billingKeyOf(event);
  let row;
  for (const candidate of state.rows)
    if (candidate[0] === hour && candidate[1] === model) {
      row = candidate;
      break;
    }
  if (row === undefined) {
    row = [hour, model, 0, 0, 0, 0, 0, 0];
    state.rows.push(row);
  }
  const input = count(usage.inputTokens);
  const output = count(usage.outputTokens);
  const cacheRead = count(usage.cacheReadTokens);
  const cacheWrite = count(usage.cacheWriteTokens);
  row[2] += input;
  row[3] += output;
  row[4] += cacheRead;
  row[5] += cacheWrite;
  row[6] += count(usage.totalTokens) || input + output + cacheRead + cacheWrite;
  row[7] += 1;
  return state;
}

/**
 * Fold ONE event into the P2 metric side of a projection state.
 *
 * Exported as a named kernel so the registry (or a test) can exercise the
 * metric fold on its own. It is a thin wrapper over foldMetricsInto: the live
 * state keeps the internal fold, while a value rehydrated from a serialized
 * row is normalized back to that shape before folding.
 * @param metrics - the state's metrics field, internal or serialized.
 * @param event - one committed session event.
 * @param timeZone - IANA zone that decides the local day.
 * @returns the internal metrics fold.
 */
export function applyMetricsEvent(metrics, event, timeZone) {
  const internal =
    metrics !== null &&
    typeof metrics === "object" &&
    Array.isArray(metrics.days)
      ? deserializeMetrics(metrics)
      : metrics;
  return foldMetricsInto(
    internal === null || typeof internal !== "object" ? emptyMetrics() : internal,
    event,
    timeZone,
  );
}

/**
 * Convert a stored state into slot rows, in the order a fresh fold produces.
 *
 * Rows are validated rather than trusted: a stored row is a structured clone of
 * a previous fold, but a damaged document must degrade to "that row is
 * dropped", never to a NaN in the panel's totals.
 * @param state - a state read back from the projection cache.
 * @returns the slot rows.
 */
export function slotsOf(state) {
  const rows = state?.rows;
  if (!Array.isArray(rows)) return [];
  const slots = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 8) continue;
    const [hour, model] = row;
    if (typeof hour !== "string" || typeof model !== "string") continue;
    const numbers = row.slice(2, 8);
    if (!numbers.every((value) => Number.isFinite(value))) continue;
    slots.push([hour, model, ...numbers]);
  }
  return slots.sort(compareSlots);
}

/**
 * Order slot rows the way a fold reports them: by hour, then by model.
 * @param left - one slot row.
 * @param right - another slot row.
 * @returns the sort order.
 */
function compareSlots(left, right) {
  if (left[0] !== right[0]) return left[0] < right[0] ? -1 : 1;
  if (left[1] === right[1]) return 0;
  return left[1] < right[1] ? -1 : 1;
}

/**
 * The state a stored document decodes to, or undefined when it is unusable.
 * @param value - the value served for this key.
 * @returns a state, or undefined.
 */
export function stateOf(value) {
  if (value === null || typeof value !== "object") return undefined;
  if (!Array.isArray(value.rows)) return undefined;
  return {
    zone: typeof value.zone === "string" ? value.zone : "",
    title: typeof value.title === "string" ? value.title : "",
    rows: value.rows,
    // The stored/cached row carries metrics in serialized column form; rebuild
    // the internal fold so a resumed fold can keep counting into it.
    metrics: deserializeMetrics(value.metrics),
  };
}

/**
 * Build the projection definition the registry registers.
 *
 * The zone is captured rather than read per event: a slot's hour depends on the
 * user's display zone, and a fold that straddled a zone change would put one
 * event's tokens in one hour bucket and the next event's in another. A zone
 * change therefore leaves the stored rows keyed to the old one, which is why
 * the state carries it — a reader can see the mismatch and refold instead of
 * billing the same hour twice under two clocks.
 * @param options - the fold's fixed inputs.
 * @param options.timeZone - the zone that decides slot boundaries.
 * @param options.hourKey - the hour bucketing function.
 * @param options.schema - the schema the registry validates its rows with.
 * @returns the definition.
 */
export function usageProjection({ timeZone, hourKey, schema }) {
  return {
    key: USAGE_PROJECTION_KEY,
    stateVersion: USAGE_STATE_VERSION,
    stateSchema: schema,
    init: () => emptyState(timeZone),
    apply: (state, event) =>
      applyEvent(state, event, (time) => hourKey(time, timeZone), timeZone),
    wire: {
      viewSchema: schema,
      // The stored state IS the view: the panel's reader wants the rows, not a
      // second rendering of them. Metrics are the one exception: the Host
      // stores the state as structured-clone-ish data, so a Map/WeakMap-backed
      // internal fold does not survive that boundary. Persist metrics in
      // SERIALIZED form (serializeMetrics on write, deserializeMetrics on read
      // in stateOf) - plain column rows are JSON-safe and keep the same
      // contract the Client already reads.
      view: (state) => ({
        ...state,
        metrics: serializeMetrics(state?.metrics),
      }),
    },
  };
}
