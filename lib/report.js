/**
 * Periodic report generation from one snapshot.
 *
 * The snapshot's day rows are [day, input, output, cacheRead, cacheWrite,
 * total, calls, cost, ...peak columns] — only the first eight are read here,
 * and every access is guarded so a partial or null snapshot degrades to
 * ok:false rather than throwing.
 */

import { wallClock } from "./time.js";

export const REPORT_PERIODS = ["day", "week", "month"];

const pad2 = (n) => String(n).padStart(2, "0");
const dayOf = (ms, zone) => {
  const c = wallClock(ms, zone);
  return c.year + "-" + pad2(c.month) + "-" + pad2(c.day);
};
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * Build one report.
 * @param {object} snapshot - the decorated snapshot.
 * @param {object} [options] - {period, timeZone, currency, now}.
 * @returns {object} a plain, JSON-safe report.
 */
export function buildReport(snapshot, options = {}) {
  const period = REPORT_PERIODS.includes(options.period) ? options.period : "week";
  const zone = options.timeZone ?? "Asia/Shanghai";
  const currency = options.currency ?? "CNY";
  const now = options.now ?? Date.now();
  const generatedAt = now;
  const today = dayOf(now, zone);
  const c = wallClock(now, zone);
  const daysBack = (n) => dayOf(now - n * 86_400_000, zone);
  let from = today, to = today;
  if (period === "week") from = daysBack(6);
  if (period === "month") from = c.year + "-" + pad2(c.month) + "-01";

  if (snapshot === null || snapshot === undefined || !Array.isArray(snapshot.days))
    return { ok: false, error: "snapshot has no day rows", period, from, to,
      generatedAt, currency, days: [], totals: {}, topModels: [], topWorkspaces: [],
      toolUsage: null, budget: null, highlights: [] };

  const days = [];
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, calls: 0, cost: 0 };
  for (const row of snapshot.days) {
    // A torn row shorter than the stable 8 columns is dropped rather than
    // zero-filled: zero-filling would invent a day with no usage at all and
    // make the report claim more covered days than the log actually has.
    if (!Array.isArray(row) || row.length < 8 || typeof row[0] !== "string") continue;
    if (row[0] < from || row[0] > to) continue;
    const d = [row[0], num(row[1]), num(row[2]), num(row[3]), num(row[4]),
      num(row[5]), num(row[6]), num(row[7])];
    days.push(d);
    totals.input += d[1]; totals.output += d[2]; totals.cacheRead += d[3];
    totals.cacheWrite += d[4]; totals.total += d[5]; totals.calls += d[6];
    totals.cost += d[7];
  }
  days.sort((a, b) => (a[0] < b[0] ? -1 : 1));

  const topModels = (Array.isArray(snapshot.models) ? snapshot.models : [])
    .map((row) => [Array.isArray(row) ? String(row[0]) : "", num(Array.isArray(row) ? row[2] : 0)])
    .filter(([key]) => key !== "")
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  // sessionRows column 10 is the workspace per the README wire contract.
  const byWorkspace = new Map();
  for (const row of Array.isArray(snapshot.sessionRows) ? snapshot.sessionRows : []) {
    if (!Array.isArray(row)) continue;
    const key = typeof row[10] === "string" && row[10] !== "" ? row[10] : "(no workspace)";
    byWorkspace.set(key, (byWorkspace.get(key) ?? 0) + num(row[5]));
  }
  const topWorkspaces = [...byWorkspace.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const highlights = [
    "Total tokens this " + period + ": " + totals.total.toLocaleString("en-US") +
      " across " + totals.calls.toLocaleString("en-US") + " calls.",
    "Estimated cost: " + totals.cost.toFixed(4) + " " + currency + ".",
    "Cache hit input: " + totals.cacheRead.toLocaleString("en-US") + " tokens.",
    days.length + " day(s) with recorded usage from " + from + " to " + to + ".",
    topModels.length > 0 ? "Top model: " + topModels[0][0] + "." : "No model breakdown available.",
  ];
  return {
    ok: true, period, from, to, generatedAt, currency, days, totals,
    topModels, topWorkspaces,
    toolUsage: snapshot.toolUsage ?? null,
    budget: snapshot.budget ?? null,
    highlights,
  };
}

/** Quote one CSV field. */
function csvField(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

/** UTF-8 BOM + CRLF CSV of one report. */
export function reportToCsv(report) {
  const header = "Day,Input,Output,Cache read,Cache write,Total,Calls,Cost";
  const lines = [header];
  for (const d of Array.isArray(report?.days) ? report.days : [])
    lines.push([d[0], d[1], d[2], d[3], d[4], d[5], d[6],
      Number(d[7] ?? 0).toFixed(4)].map(csvField).join(","));
  const t = report?.totals ?? {};
  lines.push(["TOTAL", t.input ?? 0, t.output ?? 0, t.cacheRead ?? 0,
    t.cacheWrite ?? 0, t.total ?? 0, t.calls ?? 0,
    Number(t.cost ?? 0).toFixed(4)].map(csvField).join(","));
  return "\ufeff" + lines.join("\r\n") + "\r\n";
}

/** Markdown rendition of one report. */
export function reportToMarkdown(report) {
  const t = report?.totals ?? {};
  const lines = [
    "## " + String(report?.period ?? "week") + " report: " +
      String(report?.from ?? "") + " to " + String(report?.to ?? ""),
    "",
    (Array.isArray(report?.highlights) ? report.highlights : []).join(" "),
    "",
    "| input | output | cache read | cache write | total | calls | cost |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    "| " + [t.input ?? 0, t.output ?? 0, t.cacheRead ?? 0, t.cacheWrite ?? 0,
      t.total ?? 0, t.calls ?? 0, t.cost ?? 0].join(" | ") + " |",
    "",
    "### Top models",
    ...(Array.isArray(report?.topModels) ? report.topModels : [])
      .map(([key, value]) => "- " + key + ": " + value),
  ];
  return lines.join("\n") + "\n";
}

/** A safe filename for a generated report. */
export function reportFilename(report, ext = "csv") {
  const clean = (v) => String(v ?? "all").replace(/[^A-Za-z0-9._-]/g, "-");
  const suffix = ext === "md" ? "md" : "csv";
  return "token-panorama-report-" + clean(report?.period) + "-" +
    clean(report?.from) + "-" + clean(report?.to) + "." + suffix;
}
