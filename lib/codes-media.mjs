#!/usr/bin/env node
/**
 * codes-media.mjs — 大媒体有没有写「<游戏> codes」页（2026-10-13 加，10-14 改成直接探测媒体网址）
 *
 * 为什么需要：Ship/research/GAME-WIKI-STRUCTURE-2026-10.md 查了 33 个「<游戏> codes」结果页，
 * 31 个前 5 有大媒体（GameRant / Beebom / IGN…）。媒体一铺开，独立站的 codes 页就进不去前 10；
 * 独立站只在刚出的小游戏上拿到过（Pets Universe #3、Race for Eggs #7）。
 * 所以 codes 能不能当主打，看的是「媒体来了几家」，不是 codes 词热不热。
 *
 * 规则：0–1 家 = 📣 codes 还有窗口（抢速度）· 2 家 = 🟡 · ≥3 家 = ⛔ codes 别当主打（做实体页 / 工具页）
 *
 * 为什么不数 SERP 了（10-14）：同一个 DataForSEO 接口、同样参数，几分钟内查「build an ant empire codes」
 * 一次前 7 有 6 家媒体、一次只有 1 家；treg 的便宜路由（crawl4ai / anyapi）更乱。单次 SERP 数不准。
 * 媒体的 codes 页网址是固定格式，直接请求就知道写没写——免费、每次结果一样。
 * 校验过：编造的游戏名 0 家；Hole Fishing 只有 urgametips（我们当时拿下了 codes 词）；
 * Build An Ant Empire / Deep Fishing 各 6 家；Command An Army 5 家（我们站只拿到 8 次点击）。
 *
 * 结果按游戏缓存 1 天（data/codes-media-cache.json）。
 *
 * 2026-10-22 修漏计（Roblox Stock Exchange 2 探到 2 家，实际 5 家）：
 *   名字本身以 “Roblox ” 开头时，GameRant 的两种拼法都被拼成 roblox-roblox-… / …-codes-roblox，
 *   真网址 gamerant.com/roblox-stock-exchange-2-codes/ 一条都不试。补上裸拼法；
 *   另加 robloxden.com（实测 pattern game-codes/<slug>，200）。缓存版本升到 3 让旧结果重探。
 *
 * 2026-10-20 修两个误判：
 *   ① 403/429/451/503 原来算「没写」——progameguides / tryhardguides 对我们永久 403（换 UA、换 Jina 都挡），
 *      每家游戏都白少算 0–2 家。现在算「被挡」，混进返回的 blocked，不够判定就标 ❓ 让人自己查 SERP。
 *   ② 缓存 3 天太慢：Pa Deliber 10-18 探到 0 家，10-19 destructoid / urgametips 已经写了，报告仍在喊「还有窗口」。改 1 天。
 *
 * 用法：node lib/codes-media.mjs "Blox Fruits" "Pets Universe"
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normName } from './tool-demand.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = join(HERE, '..', 'data', 'codes-media-cache.json');
const TTL = 86400_000;
const BLOCKED_STATUS = new Set([401, 403, 429, 451, 503]);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

/**
 * 各媒体 codes 页的网址格式（同一家有两种写法的都列上）
 *
 * 不收 progameguides.com / tryhardguides.com（2026-10-20）：整站对本机 IP 永久 403——换 UA、换浏览器
 * headers、换 Jina 都挡。留着只会让每家游戏都带一句「被挡未计」的噪声；当它不存在，数字就是下限。
 */
export const MEDIA_URLS = [
  ['beebom.com', (s) => [`https://beebom.com/${s}-codes/`]],
  ['pockettactics.com', (s) => [`https://www.pockettactics.com/${s}-codes`, `https://www.pockettactics.com/${s}/codes`]],
  ['gamerant.com', (s) => [`https://gamerant.com/${s}-codes/`, `https://gamerant.com/${s}-codes-roblox/`, `https://gamerant.com/roblox-${s}-codes/`]],
  ['pcgamesn.com', (s) => [`https://www.pcgamesn.com/roblox/${s}-codes`]],
  ['destructoid.com', (s) => [`https://www.destructoid.com/${s}-codes/`]],
  ['urgametips.com', (s) => [`https://urgametips.com/${s}-codes/`]],
  ['sportskeeda.com', (s) => [`https://www.sportskeeda.com/roblox-news/${s}-codes`]],
  ['thegamer.com', (s) => [`https://www.thegamer.com/roblox-${s}-codes/`]],
  ['robloxden.com', (s) => [`https://robloxden.com/game-codes/${s}`]],
];

/** 「Don't Be Late!」→ dont-be-late（媒体网址把撇号直接去掉） */
export function mediaSlug(game) {
  return String(game).toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** 纯函数：写了 codes 页的媒体 → { media, verdict, label } */
export function classifyMedia(media, blocked = []) {
  const n = media.length;
  // 被挡的家数 ≥ 能判定阈值（再来 2 家就到 mixed）时，「0 家 = 窗口」就是瞎猜
  if (blocked.length >= 2 && n <= 1) {
    return { media, blocked, verdict: 'unverified', label: `❓ codes 媒体 ${n} 家（${blocked.length} 家被挡，查不了）· 自己 SERP 确认` };
  }
  const verdict = n <= 1 ? 'open' : n === 2 ? 'mixed' : 'closed';
  const sure = blocked.length ? `（另有 ${blocked.length} 家被挡未计）` : '';
  const label = {
    open: `📣 codes 媒体 ${n} 家${sure} · codes 还有窗口（抢速度）`,
    mixed: `🟡 codes 媒体 ${n} 家${sure}`,
    closed: `⛔ codes 媒体 ${n} 家${sure} · codes 别当主打（做实体页 / 工具页）`,
  }[verdict];
  return { media, blocked, verdict, label };
}

/** 200 且没被跳到别处（跳首页 / 搜索页的不算） → true；被反爬挡 / 网络错误 → null，挡与错分开记 */
async function pageExists(url, slug) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
    res.body?.cancel();
    if (BLOCKED_STATUS.has(res.status)) return 'blocked';
    return res.status === 200 && res.url.includes(slug);
  } catch {
    return null;
  }
}

export async function probeMedia(game, { exists = pageExists } = {}) {
  const slug = mediaSlug(game);
  const checks = await Promise.all(MEDIA_URLS.map(async ([domain, urls]) => {
    const results = await Promise.all(urls(slug).map((u) => exists(u, slug)));
    return {
      domain,
      hit: results.includes(true),
      blocked: !results.includes(true) && results.includes('blocked'),
      failed: results.every((r) => r === null),
    };
  }));
  if (checks.every((c) => c.failed)) throw new Error('媒体网站全部请求失败');
  return classifyMedia(checks.filter((c) => c.hit).map((c) => c.domain), checks.filter((c) => c.blocked).map((c) => c.domain));
}

function readJson(file, fallback) {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback; } catch { return fallback; }
}

/**
 * 批量查。返回 Map<名字, 结果>；结果 = classifyMedia 的输出 + { checkedAt, cached }，
 * 或 { verdict:'failed', label }。永不抛。
 */
export async function codesMediaBatch(names) {
  const out = new Map();
  const cache = readJson(CACHE_FILE, {});
  for (const game of [...new Set(names.filter(Boolean))]) {
    const key = normName(game);
    const hit = cache[key];
    // 只认探测版的缓存（有 checkedAt、没有旧 SERP 版的 relevant 字段）
    if (hit && hit.v === 3 && hit.relevant === undefined && Date.now() - Date.parse(hit.checkedAt) < TTL) { out.set(game, { ...hit, cached: true }); continue; }
    try {
      const r = { ...(await probeMedia(game)), checkedAt: new Date().toISOString(), v: 3 };
      cache[key] = r;
      out.set(game, r);
    } catch (error) {
      out.set(game, { verdict: 'failed', label: `codes 媒体 查询失败（${String(error.message).slice(0, 60)}）` });
    }
  }
  for (const [k, v] of Object.entries(cache)) if (v.relevant !== undefined || Date.now() - Date.parse(v.checkedAt) > TTL) delete cache[k];
  try { writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2) + '\n'); } catch { /* 缓存写不进不影响结果 */ }
  return out;
}

const IS_MAIN = Boolean(process.argv[1]?.endsWith('codes-media.mjs'));
if (IS_MAIN) {
  const games = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!games.length) {
    console.error('用法: node lib/codes-media.mjs "游戏名" ["游戏名2" ...]');
    process.exit(1);
  }
  const res = await codesMediaBatch(games);
  for (const g of games) {
    const r = res.get(g);
    console.log(`${g}: ${r.label}${r.media?.length ? `（${r.media.join(' / ')}）` : ''}${r.cached ? '（缓存）' : ''}`);
  }
}
