/**
 * Optional, best-effort price-sheet synchronization.
 *
 * NO stable public model-price API is guaranteed to exist. Every source here
 * is keyless and optional; a failure is reported honestly and never throws.
 * The manually maintained price sheet (Config.models) stays authoritative:
 * this module only proposes rows for a settings window to review, and even a
 * successful fetch never writes anything by itself.
 */

/** Public endpoints tried in order. All are optional and may disappear. */
export const PRICE_SOURCES = [
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
  "https://openrouter.ai/api/v1/models",
];

/** Guardrails so an unbounded third-party payload cannot bloat the form. */
export const PRICE_SYNC_LIMITS = { maxEntries: 500, timeoutMs: 8000 };

const RATE_KEYS = ["input", "cacheRead", "cacheWrite", "output"];

/** Coerce one rate to a finite non-negative number, or null. */
function rate(value) {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
}

/** Normalize one third-party entry, or null when it is unusable. */
function normalize(key, value) {
  if (typeof key !== "string" || key.trim() === "") return null;
  const source = value && typeof value === "object" ? value : {};
  const row = {};
  for (const field of RATE_KEYS) {
    const candidates = [
      source[field],
      source[field === "cacheRead" ? "cache_read_input_token_cost" : field],
      source[field === "cacheWrite" ? "cache_creation_input_token_cost" : field],
      source[field === "input" ? "input_cost_per_token" : undefined],
      source[field === "output" ? "output_cost_per_token" : undefined],
      source?.pricing?.[field === "input" ? "prompt" : field === "output" ? "completion" : field],
    ];
    let picked = null;
    for (const candidate of candidates) {
      const n = rate(candidate);
      if (n !== null) { picked = n; break; }
    }
    if (picked === null) return null;
    row[field] = picked;
  }
  return { key: key.trim(), ...row, peakProfile: "" };
}

/**
 * Fetch and normalize a price catalog.
 * @param {object} [options] - {fetchImpl, timeoutMs, sources}.
 * @returns {Promise<{ok: boolean, source: string|null, entries: Array, error: string|null}>}
 */
export async function fetchPriceCatalog(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? PRICE_SYNC_LIMITS.timeoutMs;
  const sources = options.sources ?? PRICE_SOURCES;
  let lastError = "no usable price source";
  for (const url of sources) {
    try {
      const signal = typeof AbortSignal?.timeout === "function"
        ? AbortSignal.timeout(timeoutMs)
        : undefined;
      const response = await fetchImpl(url, signal === undefined ? {} : { signal });
      if (!response?.ok) { lastError = "HTTP " + String(response?.status); continue; }
      const payload = await response.json();
      const raw = Array.isArray(payload)
        ? payload.map((entry) => [entry?.key ?? entry?.id ?? entry?.model, entry])
        : payload && typeof payload === "object"
          ? Object.entries(payload.data ?? payload.models ?? payload)
          : [];
      const entries = [];
      for (const [key, value] of raw) {
        const row = normalize(key, value);
        if (row !== null) entries.push(row);
        if (entries.length >= PRICE_SYNC_LIMITS.maxEntries) break;
      }
      if (entries.length === 0) { lastError = "no normalized rows"; continue; }
      entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      return { ok: true, source: url, entries, error: null };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { ok: false, source: null, entries: [], error: lastError };
}

/**
 * Merge fetched rows into a config price sheet without mutating either input.
 * @param {object} existing - Config.models.
 * @param {Array} entries - normalized rows.
 * @param {object} [options] - {onlyMissing}.
 * @returns {object} a new plain object.
 */
export function mergePriceRows(existing, entries, options = {}) {
  const onlyMissing = options.onlyMissing !== false;
  const out = { ...(existing && typeof existing === "object" ? existing : {}) };
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry.key !== "string" || entry.key === "") continue;
    if (onlyMissing && out[entry.key] !== undefined) continue;
    out[entry.key] = {
      input: rate(entry.input) ?? 0,
      cacheRead: rate(entry.cacheRead) ?? 0,
      cacheWrite: rate(entry.cacheWrite) ?? 0,
      output: rate(entry.output) ?? 0,
      peakProfile: typeof entry.peakProfile === "string" ? entry.peakProfile : "",
    };
  }
  return out;
}

/** Summarize what a merge would do, for the settings UI. */
export function priceSyncSummary(existing, entries) {
  const current = existing && typeof existing === "object" ? existing : {};
  const rows = Array.isArray(entries) ? entries : [];
  let added = 0, updated = 0, skipped = 0;
  for (const entry of rows) {
    if (!entry || typeof entry.key !== "string") { skipped += 1; continue; }
    if (current[entry.key] === undefined) added += 1;
    else updated += 1;
  }
  return { total: rows.length, added, updated, skipped };
}
