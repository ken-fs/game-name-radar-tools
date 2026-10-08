import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// 2026-10-08：google-trends-api 不带 Cookie，天天被 302 到 /sorry；换成带 Cookie 的同接口替身
import googleTrends from './google-trends.mjs';

const DEFAULT_SEEDS = [
  'itch io',
  'indie game',
  'horror game',
];

const GENERIC_ONLY = new Set([
  'itch','io','indie','game','games','horror','browser','html5','online','free','new','best','top','steam','demo','jam','pc','mobile',
  'play','download','walkthrough','gameplay','release','date','2025','2026','2027','multiplayer','singleplayer','website','web',
]);

function normalizeWhitespace(value='') {
  return value.replace(/\s+/g,' ').trim();
}

function cleanQuery(value='') {
  return normalizeWhitespace(value)
    .replace(/\b(?:play|download)\s+/gi,'')
    .replace(/\s+(?:game|games|online|free|demo|walkthrough|gameplay|release date|itch io|steam)$/gi,'')
    .replace(/^(?:new|best|top|free)\s+/gi,'')
    .trim();
}

function isLikelyGameName(query, seed) {
  const cleaned = cleanQuery(query);
  if (!cleaned || cleaned.length < 3 || cleaned.length > 64) return false;
  const lower = cleaned.toLowerCase();
  if (lower === seed.toLowerCase()) return false;
  if (/^(?:how|what|when|where|why|who|is|are|can|does|best|top)\b/i.test(cleaned)) return false;
  if (/\b(?:download apk|mod apk|crack|torrent|cheat|codes?)\b/i.test(cleaned)) return false;
  const words = lower.replace(/[^a-z0-9]+/g,' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 8) return false;
  const meaningful = words.filter(word => !GENERIC_ONLY.has(word) && !/^\d+$/.test(word));
  return meaningful.length >= 1;
}

function parseRankedList(raw, seed, days) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const lists = data?.default?.rankedList || [];
  const risingList = lists[1]?.rankedKeyword || [];
  const fallback = risingList.length ? risingList : (lists[0]?.rankedKeyword || []);
  const now = new Date().toISOString();
  const entries = [];
  const seen = new Set();

  for (const item of fallback) {
    const original = normalizeWhitespace(String(item?.query || ''));
    const gameName = cleanQuery(original);
    if (!isLikelyGameName(original, seed)) continue;
    const key = gameName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const growthText = String(item?.formattedValue || item?.value || '');
    entries.push({
      title: gameName,
      gameName,
      date: now,
      growth: growthText,
      seed,
      windowDays: days,
      url: `https://trends.google.com/trends/explore?date=${days===7?'now 7-d':'today 1-m'}&geo=US&q=${encodeURIComponent(original)}`,
    });
  }
  return entries;
}

async function relatedQueries(seed, days) {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - days * 86400000);
  const raw = await googleTrends.relatedQueries({
    keyword: seed,
    startTime,
    endTime,
    geo: 'US',
    hl: 'en-US',
    timezone: 240,
  });
  return parseRankedList(raw, seed, days);
}

export async function discoverRisingGameQueries(options={}) {
  const seeds = options.seeds || DEFAULT_SEEDS;
  const windows = options.windows || [7,30];
  const results = [];

  for (const seed of seeds) {
    for (const days of windows) {
      try {
        const entries = await relatedQueries(seed, days);
        results.push({
          source: {
            id: `trends-rising-${days}d-${seed.replace(/[^a-z0-9]+/gi,'-')}`,
            name: `Trends上涨 ${days}天 · ${seed}`,
            kind: days===7 ? 'trends-rising-7d' : 'trends-rising-30d',
            url: `https://trends.google.com/trends/explore?date=${days===7?'now 7-d':'today 1-m'}&geo=US&q=${encodeURIComponent(seed)}`,
          },
          entries,
          ok: true,
        });
      } catch (error) {
        results.push({
          source: {
            id: `trends-rising-${days}d-${seed.replace(/[^a-z0-9]+/gi,'-')}`,
            name: `Trends上涨 ${days}天 · ${seed}`,
            kind: days===7 ? 'trends-rising-7d' : 'trends-rising-30d',
            url: '',
          },
          entries: [],
          ok: false,
          error: error.message,
        });
      }
      await new Promise(resolve => setTimeout(resolve, 2500));
    }
  }
  return results;
}

export { cleanQuery, isLikelyGameName, parseRankedList };
