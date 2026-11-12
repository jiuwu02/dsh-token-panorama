/**
 * Report generation: period filtering, totals, CSV/Markdown, tolerance.
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const load = (relative) => import(pathToFileURL(join(root, relative)).href);
const m = await load("lib/report.js");

// Fixed UTC instant; the default zone is Asia/Shanghai, so "today" is 2026-11-12.
const now = Date.UTC(2026, 10, 12, 4, 0, 0);
const snapshot = {
  days: [
    ["2026-11-01", 1, 2, 3, 4, 10, 1, 0.1],
    ["2026-11-10", 10, 20, 30, 40, 100, 2, 1.0],
    ["2026-11-12", 5, 6, 7, 8, 26, 3, 0.5, "extra peak columns ignored"],
    ["2026-11-12"], // a torn row, shorter than 8 columns
  ],
  models: [["m/a", 0, 50, 1], ["m/b", 0, 10, 1]],
  sessionRows: [
    ["s1", "", 0, 0, 0, 100, 1, "", [], 0, "C:/work/a"],
    ["s2", "", 0, 0, 0, 40, 1, "", [], 0, "C:/work/b"],
  ],
  toolUsage: { calls: 2 },
  budget: { dailyTokens: 100 },
};

assert.deepEqual(m.REPORT_PERIODS, ["day", "week", "month"]);
const week = m.buildReport(snapshot, { now, period: "week" });
assert.equal(week.ok, true);
assert.equal(week.from, "2026-11-06");
assert.equal(week.to, "2026-11-12");
assert.equal(week.days.length, 2, "only rows inside the span survive");
assert.equal(week.totals.total, 126);
assert.equal(week.totals.cost, 1.5);
assert.equal(week.days[1].length, 8, "each day row is reduced to the stable 8 columns");
assert.equal(week.topModels[0][0], "m/a");
assert.equal(week.topWorkspaces[0][0], "C:/work/a");
assert.ok(week.highlights.length >= 3);

const day = m.buildReport(snapshot, { now, period: "day" });
assert.equal(day.from, "2026-11-12");
assert.equal(day.days.length, 1);

const csv = m.reportToCsv(week);
assert.ok(csv.startsWith("\ufeff"), "UTF-8 BOM");
assert.ok(csv.includes("\r\n"), "CRLF line endings");
assert.ok(csv.trimEnd().endsWith("TOTAL,15,26,37,48,126,5,1.5000"), "TOTAL row");

const md = m.reportToMarkdown(week);
assert.ok(md.startsWith("## week report:"));
assert.ok(md.includes("| input | output |"));
assert.ok(md.includes("### Top models"));

assert.match(m.reportFilename(week, "md"), /^token-panorama-report-week-.*\.md$/);

const nullReport = m.buildReport(null, { now });
assert.equal(nullReport.ok, false);
assert.deepEqual(nullReport.days, []);
assert.equal(typeof nullReport.error, "string");

console.log("report ok: periods, totals, csv, markdown, tolerance");
