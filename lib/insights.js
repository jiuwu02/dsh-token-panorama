/**
 * Pure derivations the panel draws on top of the snapshot's day rows.
 *
 * Every function here takes the wire rows as they arrive and never mutates
 * them. Keeping the arithmetic out of client.js means each new card can be
 * pinned by a small node:assert test instead of a browser click, and the day
 * row contract (see README "HTTP API") stays in one place.
 *
 * A day row is [day, input, output, cacheRead, cacheWrite, total, calls, cost,
 * ...peak columns]. Only the first eight columns are read here.
 */

/** Coerce one wire value to a finite non-negative number. */
function num(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/**
 * One point per day: cache hit rate and cost per million tokens.
 * Cache writes are excluded from the hit-rate denominator by definition — a
 * write is not a read — so the denominator is input + cacheRead only.
 * @param {Array} days - day rows.
 * @returns {{days: Array, avgHitRate: number, avgUnitCost: number}}
 */
export function rateSeries(days) {
  const rows = Array.isArray(days) ? days : [];
  const out = [];
  let denom = 0;
  let hits = 0;
  let tokens = 0;
  let cost = 0;
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const input = num(row[1]);
    const cacheRead = num(row[3]);
    const total = num(row[5]);
    const spent = num(row[7]);
    const d = input + cacheRead;
    denom += d;
    hits += cacheRead;
    tokens += total;
    cost += spent;
    out.push({
      day: row[0],
      hitRate: d > 0 ? cacheRead / d : 0,
      unitCost: total > 0 ? (spent / total) * 1_000_000 : 0,
      total,
      cost: spent,
    });
  }
  return {
    days: out,
    avgHitRate: denom > 0 ? hits / denom : 0,
    avgUnitCost: tokens > 0 ? (cost / tokens) * 1_000_000 : 0,
  };
}

/**
 * A moving average over a numeric field of rateSeries() points.
 * @param {Array} points - rateSeries().days.
 * @param {string} field - "hitRate" | "unitCost" | "total" | "cost".
 * @param {number} window - number of points to average.
 * @returns {number[]} same length, null for the first window-1 points.
 */
export function movingAverage(points, field, window = 7) {
  const size = Math.max(1, Math.floor(window));
  const rows = Array.isArray(points) ? points : [];
  const out = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (i + 1 < size) { out.push(null); continue; }
    let sum = 0;
    for (let j = i - size + 1; j <= i; j += 1) sum += num(rows[j]?.[field]);
    out.push(sum / size);
  }
  return out;
}

/**
 * Compare the current span with the immediately preceding span of equal
 * length (period-over-period), and with the same span one year earlier
 * (year-over-year). Rows outside the available history are simply absent, so
 * a young profile reports null rather than a fabricated -100%.
 * @param {Array} days - ALL day rows, sorted by day string.
 * @param {string} from - inclusive local date "YYYY-MM-DD".
 * @param {string} to - inclusive local date "YYYY-MM-DD".
 * @returns {{current: object, previous: object|null, lastYear: object|null, delta: object|null}}
 */
export function periodComparison(days, from, to) {
  const rows = (Array.isArray(days) ? days : [])
    .filter((row) => Array.isArray(row) && typeof row[0] === "string");
  const span = (a, b) => rows.filter((row) => row[0] >= a && row[0] <= b);
  // An empty comparison span must be null, not a zero object: a profile with
  // no history a year ago does not have a -100% year-over-year change.
  const sum = (list) => list.length === 0 ? null : list.reduce((acc, row) => {
    acc.total += num(row[5]);
    acc.calls += num(row[6]);
    acc.cost += num(row[7]);
    return acc;
  }, { total: 0, calls: 0, cost: 0 });
  const shift = (date, daysBack) => {
    const d = new Date(date + "T00:00:00Z");
    if (Number.isNaN(d.getTime())) return null;
    d.setUTCDate(d.getUTCDate() + daysBack);
    return d.toISOString().slice(0, 10);
  };
  const length = Math.round(
    (Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86_400_000,
  ) + 1;
  const current = sum(span(from, to));
  const prevTo = shift(from, -1);
  const prevFrom = shift(from, -length);
  const previous = prevTo && prevFrom ? sum(span(prevFrom, prevTo)) : null;
  const lyTo = shift(to, -365);
  const lyFrom = shift(from, -365);
  const lastYear = lyTo && lyFrom ? sum(span(lyFrom, lyTo)) : null;
  const pct = (a, b) => (b > 0 ? (a - b) / b : null);
  return {
    current,
    previous,
    lastYear,
    delta: {
      total: pct(current.total, previous?.total ?? 0),
      calls: pct(current.calls, previous?.calls ?? 0),
      cost: pct(current.cost, previous?.cost ?? 0),
      yoyTotal: pct(current.total, lastYear?.total ?? 0),
    },
  };
}

/**
 * Budget progress for the four configured thresholds.
 * A limit of 0 disables that budget. The returned status is "off" | "ok" |
 * "warning" (>= warnAt, default 0.8) | "exceeded" (> 1). The ETA is a simple
 * linear projection from the current period's elapsed share, not a forecast
 * model: it is honest about being an extrapolation.
 * @param {object} budget - {dailyTokens, weeklyTokens, dailyCost, weeklyCost}.
 * @param {object} used - {dayTokens, weekTokens, dayCost, weekCost}.
 * @param {object} [options] - {warnAt, elapsedShare, now, zone}.
 * @returns {Array} one entry per threshold plus a summary.
 */
export function budgetProgress(budget, used, options = {}) {
  const warnAt = options.warnAt ?? 0.8;
  const share = Math.min(1, Math.max(0, options.elapsedShare ?? 1));
  const pairs = [
    ["dailyTokens", "dayTokens", "tokens"],
    ["weeklyTokens", "weekTokens", "tokens"],
    ["dailyCost", "dayCost", "cost"],
    ["weeklyCost", "weekCost", "cost"],
  ];
  const limits = budget ?? {};
  const spent = used ?? {};
  const entries = pairs.map(([key, usedKey, unit]) => {
    const limit = num(limits[key]);
    const value = num(spent[usedKey]);
    const ratio = limit > 0 ? value / limit : 0;
    const status = limit <= 0 ? "off" : ratio > 1 ? "exceeded" : ratio >= warnAt ? "warning" : "ok";
    return {
      key, unit, limit, used: value, ratio,
      remaining: limit > 0 ? Math.max(0, limit - value) : null,
      status,
      eta: limit > 0 && share > 0 && value > 0 ? value / share : null,
    };
  });
  const active = entries.filter((e) => e.status !== "off");
  return {
    entries,
    summary: {
      warning: active.some((e) => e.status === "warning" || e.status === "exceeded"),
      exceeded: active.some((e) => e.status === "exceeded"),
      activeCount: active.length,
    },
  };
}

/**
 * Break the tool-ledger summary into one row per purpose for a small chart.
 * @param {object} toolUsage - decorate()'s toolUsage block.
 * @returns {Array<{purpose: string, tokens: number, cost: number, calls: number}>}
 */
export function toolBreakdown(toolUsage) {
  const byPurpose = Array.isArray(toolUsage?.byPurpose) ? toolUsage.byPurpose : [];
  const rows = byPurpose.map((entry) => ({
    purpose: typeof entry.purpose === "string" ? entry.purpose : "unknown",
    tokens: num(entry.total),
    cost: num(entry.cost),
    calls: num(entry.calls),
  }));
  // The named sub-blocks are the three this plugin actually spends on; include
  // them even when byPurpose is missing (older snapshots).
  for (const [purpose, key] of [
    ["compaction", "compaction"],
    ["prompt-optimizer", "optimizer"],
    ["ask-answer", "answer"],
  ]) {
    if (rows.some((r) => r.purpose === purpose)) continue;
    const block = toolUsage?.[key];
    if (block !== undefined && block !== null)
      rows.push({ purpose, tokens: num(block.tokens ?? block.consumedTokens), cost: num(block.cost), calls: num(block.calls) });
  }
  return rows.sort((a, b) => b.tokens - a.tokens);
}

/**
 * Data-health facts the panel can show instead of silently guessing.
 * @param {object} doc - the snapshot.
 * @returns {object} plain, JSON-safe.
 */
export function dataHealth(doc) {
  const days = Array.isArray(doc?.days) ? doc.days : [];
  const unpriced = Array.isArray(doc?.billing?.unpriced) ? doc.billing.unpriced : [];
  const metrics = doc?.metrics ?? null;
  return {
    hasMetrics: metrics !== null,
    cacheVersion: doc?.cacheVersion ?? null,
    lastScanAt: doc?.lastScanAt ?? null,
    generatedAt: doc?.generatedAt ?? null,
    dayCount: days.length,
    firstDay: days.length > 0 ? days[0][0] : null,
    lastDay: days.length > 0 ? days[days.length - 1][0] : null,
    unpricedModels: unpriced,
    sessions: doc?.sessions ?? null,
    stale: doc?.stale === true,
  };
}
