/**
 * P1 insight derivations: pure arithmetic over the wire day rows.
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const load = (relative) => import(pathToFileURL(join(root, relative)).href);
const m = await load("lib/insights.js");

const days = [
  ["2026-11-01", 100, 50, 100, 10, 260, 2, 0.5],
  ["2026-11-02", 200, 60, 0, 0, 260, 3, 1.0],
  ["2026-11-03", 100, 40, 300, 0, 440, 4, 2.0],
];

const rates = m.rateSeries(days);
assert.equal(rates.days.length, 3);
// Day 1: 100 read / (100 input + 100 read) = 0.5; cache writes excluded.
assert.equal(rates.days[0].hitRate, 0.5);
assert.equal(rates.days[1].hitRate, 0);
assert.equal(rates.days[2].hitRate, 0.75);
assert.ok(rates.avgHitRate > 0 && rates.avgHitRate < 1);
assert.ok(rates.avgUnitCost > 0, "unit cost is per 1M tokens");
assert.equal(rates.days[0].unitCost, (0.5 / 260) * 1_000_000);

const avg = m.movingAverage(rates.days, "hitRate", 2);
assert.equal(avg[0], null, "no average before the window fills");
assert.ok(Math.abs(avg[1] - 0.25) < 1e-9);

const cmp = m.periodComparison(days, "2026-11-02", "2026-11-03");
assert.equal(cmp.current.total, 700);
assert.equal(cmp.previous.total, 260, "equal-length preceding span");
// A young history has no year-ago rows; the result is null, not -100%.
assert.deepEqual(cmp.lastYear, null);
assert.equal(cmp.delta.yoyTotal, null);

const budget = m.budgetProgress(
  { dailyTokens: 100, weeklyTokens: 0, dailyCost: 1, weeklyCost: 10 },
  { dayTokens: 85, weekTokens: 0, dayCost: 1.2, weekCost: 3 },
  { warnAt: 0.8, elapsedShare: 0.5 },
);
assert.equal(budget.entries[0].status, "warning");
assert.equal(budget.entries[1].status, "off", "0 disables a budget");
assert.equal(budget.entries[2].status, "exceeded");
assert.equal(budget.entries[3].status, "ok");
assert.ok(budget.summary.warning && budget.summary.exceeded);
assert.equal(budget.entries[0].eta, 170, "linear projection from elapsed share");

const breakdown = m.toolBreakdown({
  byPurpose: [{ purpose: "compaction", total: 500, cost: 0.2, calls: 1 }],
  optimizer: { tokens: 100, cost: 0.05, calls: 1 },
  answer: { tokens: 20, cost: 0.01, calls: 1 },
});
assert.equal(breakdown.length, 3);
assert.equal(breakdown[0].purpose, "compaction", "sorted by tokens desc");

const health = m.dataHealth({ days, billing: { unpriced: ["m/x"] }, metrics: { days: [] } });
assert.equal(health.dayCount, 3);
assert.equal(health.hasMetrics, true);
assert.deepEqual(health.unpricedModels, ["m/x"]);
assert.equal(m.dataHealth(null).hasMetrics, false, "null snapshot is safe");

console.log("insights ok: rates, moving average, comparison, budget, tool breakdown, health");
