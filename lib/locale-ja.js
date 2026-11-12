/**
 * Japanese as a FALLBACK locale.
 *
 * The client's ZH and EN dictionaries carry 350+ identical keys and are pinned
 * by test/i18n.test.mjs. Translating every one into Japanese would triple that
 * maintenance for a locale the panel may never be shown in, so this module
 * overlays only the most visible labels onto a full copy of EN; every other
 * key intentionally falls back to English. makeLocale guarantees the result
 * has EXACTLY the base key set, which is what keeps the drift guard happy.
 *
 * Keys chosen (all verified to exist in client.js): nav.label, range.*,
 * stat.*, trend.*, heat.*, model.*, session.title, workspace.title,
 * budget.title, settings.title/save/cancel/tab.*, action.export*,
 * insight.title, health.title.
 */

export const JA_OVERRIDES = {
  "nav.label": "トークン概要",
  "range.label": "期間",
  "range.all": "すべて",
  "range.today": "今日",
  "range.24h": "直近24時間",
  "range.week": "今週",
  "range.7": "直近7日",
  "range.month": "今月",
  "range.30": "直近30日",
  "stat.total": "累計トークン",
  "stat.cost": "推定費用",
  "stat.hitRate": "キャッシュ命中率",
  "stat.calls": "呼出回数",
  "stat.sessions": "セッション数",
  "trend.title": "使用量トレンド",
  "heat.title": "使用量ヒートマップ",
  "heat.week": "週",
  "heat.month": "月",
  "model.title": "モデル分布",
  "model.clear": "すべて表示",
  "session.title": "セッション使用量",
  "workspace.title": "ワークスペース分布",
  "budget.title": "予算警告",
  "budget.progress": "予算進捗",
  "settings.title": "一般設定",
  "settings.save": "保存",
  "settings.cancel": "キャンセル",
  "settings.tab.models": "モデルと価格",
  "settings.tab.peaks": "ピーク時間帯",
  "settings.tab.holidays": "祝日",
  "settings.tab.general": "一般",
  "settings.tab.context": "コンテキスト",
  "settings.tab.optimizer": "プロンプト最適化",
  "settings.tab.ask": "自動回答",
  "action.export": "エクスポート",
  "action.exportCsv": "CSV をエクスポート",
  "action.exportJson": "JSON をエクスポート",
  "action.report": "レポート生成",
  "insight.title": "効率とコスト",
  "health.title": "データ状態",
};

/** Overlay translated keys onto a full base dictionary; ignore unknown keys. */
export function makeLocale(base, overrides) {
  const out = { ...(base && typeof base === "object" ? base : {}) };
  for (const [key, value] of Object.entries(overrides && typeof overrides === "object" ? overrides : {}))
    if (Object.prototype.hasOwnProperty.call(out, key)) out[key] = value;
  return out;
}

/** Count how many keys differ from the base dictionary. */
export function localeCoverage(base, locale) {
  const keys = Object.keys(base && typeof base === "object" ? base : {});
  let translated = 0;
  for (const key of keys)
    if (locale?.[key] !== undefined && locale[key] !== base[key]) translated += 1;
  return { total: keys.length, translated, fallback: keys.length - translated };
}

/** Build the Japanese dictionary from the shipped English one. */
export function japaneseLocale(enDictionary) {
  return makeLocale(enDictionary, JA_OVERRIDES);
}
