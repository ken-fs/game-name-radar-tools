#!/usr/bin/env node
/**
 * anchor.mjs — 动态量级锚点（2026-10-20 加，用户定）
 *
 * 问题：锚点原来是 .env 里写死的一个游戏词（`race for eggs codes`）。**锚点本身是会被玩家抛弃的游戏**，
 * 游戏一死锚点就没量 → 比例自动退回「按峰值比估」→ 出现「锚点的 476%」这种没意义的数字
 * （2026-10-20 查 Tap Simulator REBORN 时发现）。
 *
 * 做法（两级，各一个数据源）：
 *   ① DataForSEO（treg，$0.09 一次）给**自家站群**每个游戏的 `<名字> codes` 按最新一个月搜索量排序
 *      → 取前 5 当候选。这一步只用来**缩小范围**：Ads 会把近似词合并（`verity` 显示 409 万/月 = 和 verify 合并了），
 *      所以它的绝对值不可当尺子，但排序方向基本可用。
 *   ② 一次 Google Trends 五词对比（免费）测这 5 个词**现在**谁还有量
 *      → 近期均值最大的就是锚点。Trends 和候选量级测量用的是同一把尺，天然一致。
 *
 * 输出 data/anchor.json，30 天重测一次。锚点的 Ads 月搜索量一并存下，只作「量级参考」不当真值。
 *
 * 用法：
 *   node lib/anchor.mjs            # 看当前锚点（过期就重测）
 *   node lib/anchor.mjs --force    # 强制重测（花 $0.09 + 几次 Trends）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getOwnGames } from './own-games.mjs';
import googleTrends from './google-trends.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = join(HERE, '..', 'data', 'anchor.json');
const TREG = resolve(HERE, '..', '..', 'scripts', 'treg', 'call.py');
const TTL = 30 * 86400_000;
const SHORTLIST = 5;                 // Trends 一次最多比 5 个词
const MIN_ANCHOR_TREND = 3;          // 锚点近期均值低于这个 = 站群全没量，退常青词
const EVERGREEN = ['blox fruits codes', 'grow a garden codes', 'dress to impress codes'];
const DAY = 86400_000;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 候选：自家游戏的 `<名字> codes` + 常青词。单词名不要（会撞同形普通词，Ads 量是假的） */
async function buildPool() {
  const own = await getOwnGames();
  const pool = new Set(EVERGREEN);
  for (const n of own.names) {
    if (!n || n.length < 4) continue;
    pool.add(`${n} codes`);
  }
  return [...pool].map((w) => w.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** 月搜索量 → { 词: { latest, month, avg } }。2026-10-20 起问 Serpstat（$0.0005，DataForSEO 同问题是 $0.09） */
function volumes(words) {
  let out;
  try {
    out = execFileSync('python3', ['-I', TREG, 'serpstat.google.keywords.volume',
      JSON.stringify({ method: 'SerpstatKeywordProcedure.getKeywordsInfo', id: '1',
                       params: { keywords: words.slice(0, 1000), se: 'g_us' } })],
      { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'], timeout: 180000,
        env: { ...process.env, TREG_CALLER: 'game-anchor' } });
  } catch (e) {
    out = String(e.stdout ?? '') || e.message;
  }
  if (!out.trim().startsWith('{')) throw new Error(out.slice(0, 160));
  const rows = JSON.parse(out)?.result?.data;
  if (!Array.isArray(rows)) throw new Error(`Serpstat 返回异常：${out.slice(0, 160)}`);
  // Serpstat 只返回有数据的词（没返回 = 0/月），没有按月历史，量都用当前美国月搜索量
  const idx = Object.fromEntries(rows.map((r) => [String(r.keyword ?? '').toLowerCase(), r.region_queries_count ?? 0]));
  return Object.fromEntries(words.map((w) => {
    const v = idx[w.toLowerCase()] ?? 0;
    return [w, { latest: v, month: null, avg: v }];
  }));
}

/** Trends 五词对比 → 每个词的近期均值（同一把尺，跨词可比） */
async function liveLevels(words) {
  const raw = await googleTrends.interestOverTime({ keyword: words, startTime: new Date(Date.now() - 90 * DAY), geo: 'US' });
  const rows = (JSON.parse(raw).default?.timelineData || []).map((p) => (p.value ?? []).map(Number)).filter((v) => v.length === words.length);
  if (rows.length < 6) return null;
  const n = Math.max(6, Math.floor(rows.length * 0.15));
  const recent = rows.slice(-n);
  return words.map((w, i) => ({ word: w, recent: mean(recent.map((r) => r[i])), peak: Math.max(...rows.map((r) => r[i])) }));
}

/** 重测并写缓存 */
export async function refreshAnchor() {
  const pool = await buildPool();
  const vols = volumes(pool);
  // ① Ads 排序取前 5（只用来缩小范围）
  const ranked = pool.map((kw) => ({ kw, ...(vols[kw] ?? { latest: 0, avg: 0 }) })).sort((a, b) => b.latest - a.latest);
  const shortlist = ranked.slice(0, SHORTLIST).map((r) => r.kw);
  // ② Trends 实测谁现在还有量
  let levels = null;
  try { levels = await liveLevels(shortlist); } catch { /* 限频等 → 下面退回 Ads 排序 */ }
  const live = (levels ?? []).slice().sort((a, b) => b.recent - a.recent);
  const pick = live.find((l) => l.recent >= MIN_ANCHOR_TREND) ?? null;
  const anchor = pick?.word ?? shortlist[0];
  const out = {
    anchor,
    measured: pick ? { recent: Number(pick.recent.toFixed(1)), peak: pick.peak } : null,
    adsVolume: vols[anchor]?.latest ?? 0,   // 只作量级参考（Ads 会合并近似词）
    adsMonth: vols[anchor]?.month ?? null,
    checkedAt: new Date().toISOString(),
    method: levels ? 'ads-shortlist+trends-live' : 'ads-only(趋势对比失败)',
    // 梯子（按当前活跃度排序）：主锚点是 1 号；小候选要换更细的尺子时从这里取
    ladder: live.length ? live.map((l) => ({ word: l.word, recent: Number(l.recent.toFixed(1)) })) : shortlist.map((w) => ({ word: w, recent: null })),
    shortlist: shortlist.map((w) => ({ word: w, ads: vols[w]?.latest ?? 0, live: levels?.find((l) => l.word === w)?.recent ?? null })),
  };
  writeFileSync(FILE, JSON.stringify(out, null, 2) + '\n');
  return out;
}

/** 读锚点（过期自动重测；重测失败用旧缓存，再不行返回 null 让调用方退回 .env） */
export async function loadAnchor({ force = false } = {}) {
  let cache = null;
  try { if (existsSync(FILE)) cache = JSON.parse(readFileSync(FILE, 'utf8')); } catch { /* 坏文件当没有 */ }
  if (!force && cache && Date.now() - Date.parse(cache.checkedAt) < TTL) return cache;
  try { return await refreshAnchor(); } catch (e) {
    if (cache) { cache.staleError = String(e.message ?? e); return cache; }
    return null;
  }
}

const IS_MAIN = Boolean(process.argv[1]?.endsWith('anchor.mjs'));
if (IS_MAIN) {
  const a = await loadAnchor({ force: process.argv.includes('--force') });
  if (!a) { console.error('❌ 拿不到锚点（treg 不可用 + 无缓存）'); process.exit(1); }
  console.log(`锚点: ${a.anchor}${a.measured ? ` · Trends 近期 ${a.measured.recent}/100` : ''} · Ads 最新月(${a.adsMonth}) ${a.adsVolume.toLocaleString()}（仅参考）`);
  console.log(`测于 ${a.checkedAt} · ${a.method}${a.staleError ? ` ⚠️ 重测失败用旧缓存: ${a.staleError}` : ''}`);
  console.log('\n候选（Ads 前 5，Trends 是实测活跃度）:');
  for (const r of a.shortlist ?? []) console.log(`  ads ${String(r.ads).padStart(7)}  live ${r.live === null ? '  -  ' : String(Math.round(r.live)).padStart(3)}  ${r.word}`);
}
