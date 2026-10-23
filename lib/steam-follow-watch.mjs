#!/usr/bin/env node
/**
 * steam-follow-watch.mjs — Steam 预发布 / 刚发售游戏的关注者增速（2026-10-12 加）
 *
 * 为什么需要（全雷达复盘 REVIEW-2026-10-12 的盲区）：用户自己建了 volatiles.wiki（11 bit 刚公开的预发布
 * roguelike，appid 4210390）、emberquest.wiki（10-15 发售），但没有任何雷达报过。现有 Steam 源
 * （热门愿望单 / 热门新品 / 最新独立）看的是「榜单名次」，大作常年霸榜，刚公开的小游戏进不去；
 * 榜单也不告诉你「哪个游戏这周突然有人关注了」。
 *
 * 信号：Steam 社区「关注者」数（steamcommunity.com/games/<appid>/memberslistxml，免费、无 key）
 * 每天记一次，看日增和 7 天增长率。关注者和愿望单高度相关（独立游戏圈常用经验：愿望单 ≈ 关注者 × 7–10），
 * 而愿望单数 Steam 不公开 —— 关注者是唯一能每天免费拿到的「发售前热度」。
 *
 * 游戏池（每天重建，上限 300，按优先级截断）：
 *   ① 自家站的游戏（Ship/<站>/src 里的 store.steampowered.com/app/<id>）+ config/steam-follow.json 手动名单
 *   ② 之前报过 🟢/🌱 的（继续盯曲线）
 *   （①② 全收，下面四个来源按配额 130 / 100 / 45 / 25 取，见 buildPool）
 *   ③ 商店「即将推出」热门排序（IStoreQueryService sort=20，拉前 200；实测 Volatiles 排 86 ——
 *      它没有发售日期，不在搜索页「热门即将推出」前 1000 里）
 *   ④ 搜索页「热门即将推出」前 400 里 30 天内发售的（实测 400 个里 362 个 7 天内发售；EmberQuest 排 ~300，
 *      只有 47 个关注者，靠「自家站」进池）
 *   ⑤ 搜索页「热门新品」前 300 里 30 天内刚发售的
 *   ⑥ 每日管线 steam-top-wishlist 快照里还没发售的
 *   名字 / 发售日统一用 IStoreBrowseService/GetItems 批量拿（100 个一次）；发售超过 30 天的移出池子
 *   （自家站 / 手动名单除外）。
 *
 * 请求量：关注者每个游戏 1 次，间隔 4 秒（steamcommunity 按 IP 限流：实测约 100 次 / 10–15 分钟，超了 429），
 * 被限流就歇 150 秒，最多抓 30 分钟（约 200 个）。抓的顺序：自家站 / 之前报过 / 热度榜前 60 / 即将推出前 40
 * 每天必抓，其余按「上次抓到的日期」从旧到新轮换 —— 池子 300 个大约 1–2 天轮一遍（曲线允许隔天采样，日增按间隔天数折算）。
 * 每日管线里和 scan.mjs 并行跑，不额外拖长总时间。
 *
 * 判决（需要 ≥2 天的曲线；第一天只建基线）：
 *   🟢 起量     日增 ≥ 100 且 7 天增长 ≥ 20%，关注者 < 5 万
 *               依据：100 关注/天 ≈ 700–1000 愿望单/天，是独立游戏上「即将推出」首页的量级；
 *               20%/周 保证是「在加速」而不是底子大（大作每天 +2000 但周增长 1–3%）。
 *   🌱 小而快   关注者 < 3000，日增 ≥ 20 且 7 天增长 ≥ 50% —— 刚公开、绝对值还小但翻得快（Volatiles 这类）
 *   🔵 大作     关注者 ≥ 5 万且日增 ≥ 300 —— 热，但 IGN / GameRant / Fandom 早就在，只做参考
 *   🟡 在涨     日增 ≥ 30 或 7 天增长 ≥ 10%
 *   ⚪ 平
 *   不足 7 天曲线时，7 天增长按已有天数线性折算（报告里标「估」）。
 *
 * 🟢 / 🌱 会查「最近 3 天新注册域名」（lib/nrd.mjs）：数字大 = 同行开始抢注。
 *
 * 用法：
 *   node lib/steam-follow-watch.mjs                 # 跑一轮，写 ../reports/steamfollow/RADAR-STEAMFOLLOW-<日期>.md
 *   node lib/steam-follow-watch.mjs --limit=20      # 小规模试跑（只取池子前 20 个，不写状态和报告）
 *   node lib/steam-follow-watch.mjs 4210390 5328820 # 只查这几个 appid 的当前关注者（不写状态）
 *   不推通知：结论进 radar.mjs 的「今天最值得看」，由总报告统一推。
 */
import fs from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { reportPath } from '../../scripts/lib/reports.mjs';
import { nrdCounts, nrdNote } from './nrd.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIP = path.join(root, '..');
const statePath = path.join(root, 'data', 'steam-follow-state.json');
const configPath = path.join(root, 'config', 'steam-follow.json');
const candidatesPath = path.join(root, 'data', 'candidates.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';

export const POOL_LIMIT = Number(process.env.STEAMFOLLOW_POOL_LIMIT ?? 300);
const WINDOW_DAYS = 30;
const GAP_MS = Number(process.env.STEAMFOLLOW_GAP_MS ?? 4000); // steamcommunity 实测约 60 次 / 几分钟就 429，4 秒一个基本不触发
const MAX_MINUTES = Number(process.env.STEAMFOLLOW_MAX_MIN ?? 30); // 抓关注者最多花这么久，没抓完的明天优先
export const RULES = {
  go: { daily: 100, growth7: 0.2, maxFollowers: 50_000 },
  sprout: { maxFollowers: 3000, daily: 20, growth7: 0.5 },
  big: { minFollowers: 50_000, daily: 300 },
  rising: { daily: 30, growth7: 0.1 },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 864e5;
const localDate = (d = new Date()) => d.toLocaleDateString('sv-SE');
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

async function getText(url, timeout = 30_000) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function withRetry(fn, attempts = 3) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      if (i === attempts - 1) throw error;
      await sleep(2000 * (i + 1));
    }
  }
}

// ─── 解析（纯函数，有测试）─────────────────────────────────────────────────────

/** 搜索页 infinite=1 的 results_html → [{ appid, name, releaseText }]（捆绑包的 appid 是逗号列表，取第一个） */
export function parseSearchHtml(html = '') {
  const out = [];
  for (const m of html.matchAll(/data-ds-appid="([\d,]+)"[\s\S]*?<span class="title">([\s\S]*?)<\/span>[\s\S]*?search_released[^>]*>\s*([\s\S]*?)\s*<\/div>/g)) {
    out.push({ appid: Number(m[1].split(',')[0]), name: decodeHtml(m[2]).trim(), releaseText: decodeHtml(m[3]).trim() });
  }
  return out;
}

function decodeHtml(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/** 「Oct 12, 2026」「12 Oct, 2026」→ 2026-10-12；「Coming soon」「Q4 2026」「2027」→ null */
export function parseReleaseText(text = '') {
  const t = String(text).trim();
  const m = t.match(/^([A-Za-z]{3,9})\.? (\d{1,2}), (\d{4})$/) || t.match(/^(\d{1,2}) ([A-Za-z]{3,9})\.?,? (\d{4})$/);
  if (!m) return null;
  const [mon, day] = /^\d/.test(m[1]) ? [m[2], m[1]] : [m[1], m[2]];
  const d = new Date(`${mon} ${day}, ${m[3]} 12:00 UTC`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** memberslistxml → 关注者数（取 groupDetails 里那个，文末那个是成员列表分页用的） */
export function parseMemberCount(xml = '') {
  const m = String(xml).match(/<groupDetails>[\s\S]*?<memberCount>(\d+)<\/memberCount>/);
  return m ? Number(m[1]) : null;
}

/** GetItems 的 release 字段 → { date, text, comingSoon } */
export function describeRelease(release = {}, isComingSoon = false) {
  const ts = release.steam_release_date || release.original_release_date;
  const iso = ts ? new Date(ts * 1000).toISOString().slice(0, 10) : null;
  const display = release.coming_soon_display;
  const comingSoon = Boolean(release.is_coming_soon ?? isComingSoon);
  let text = iso || release.custom_release_date_message || (comingSoon ? 'Coming soon' : '?');
  if (iso && display === 'date_month') text = iso.slice(0, 7);
  if (iso && display === 'date_quarter') text = `${iso.slice(0, 4)} Q${Math.ceil(Number(iso.slice(5, 7)) / 3)}`;
  if (iso && display === 'date_year') text = iso.slice(0, 4);
  if (display === 'text_tba') text = 'TBA';
  if (display === 'text_comingsoon') text = release.custom_release_date_message || 'Coming soon';
  // 只有精确到日的才当「发售日」用（季度/年份的 ts 是期末，不能拿来算距发售几天）
  const exact = iso && (!display || display === 'date_full') ? iso : null;
  return { date: exact, text, comingSoon };
}

/**
 * 曲线 → 统计。history: [{date, followers}]（按日期升序，每天一条）。
 *   daily   = 最近两次采样的差 ÷ 间隔天数
 *   growth7 = 对比 5–10 天前最近 7 天的那次；不够 5 天就用最早一次按天数折算到 7 天（estimated=true）
 */
export function followerStats(history = []) {
  const h = history.filter((x) => Number.isFinite(x.followers));
  if (!h.length) return null;
  const last = h.at(-1);
  if (h.length < 2) return { followers: last.followers, spanDays: 0, daily: null, growth7: null, estimated: false };
  const prev = h.at(-2);
  const gap = Math.max(1, daysBetween(prev.date, last.date));
  const daily = (last.followers - prev.followers) / gap;
  const candidates = h.slice(0, -1).map((x) => ({ ...x, ago: daysBetween(x.date, last.date) }));
  const week = candidates.filter((x) => x.ago >= 5 && x.ago <= 10).sort((a, b) => Math.abs(a.ago - 7) - Math.abs(b.ago - 7))[0];
  const base = week || candidates[0];
  const span = Math.max(1, base.ago);
  const raw = base.followers ? (last.followers - base.followers) / base.followers : null;
  const growth7 = raw === null ? null : (raw * 7) / span;
  return { followers: last.followers, spanDays: daysBetween(h[0].date, last.date), daily: +daily.toFixed(1), growth7: growth7 === null ? null : +growth7.toFixed(3), estimated: !week };
}

/** 统计 → 判决 key（go / sprout / big / rising / flat / new） */
export function judgeFollow(stats, rules = RULES) {
  if (!stats || stats.daily === null || stats.spanDays < 2) return 'new';
  const { followers, daily, growth7 } = stats;
  const g = growth7 ?? 0;
  if (followers >= rules.big.minFollowers) return daily >= rules.big.daily ? 'big' : daily >= rules.rising.daily ? 'rising' : 'flat';
  if (daily >= rules.go.daily && g >= rules.go.growth7) return 'go';
  if (followers < rules.sprout.maxFollowers && daily >= rules.sprout.daily && g >= rules.sprout.growth7) return 'sprout';
  if (daily >= rules.rising.daily || g >= rules.rising.growth7) return 'rising';
  return 'flat';
}

/**
 * 池子截断：自家 / 手动 / 之前报过的全收；其余按来源配额（热度榜 130 · 30 天内发售 100 · 刚发售 45 · 愿望单 25），
 * 每个来源按自己的名次取；配额没用完的名额按名次补给其他来源。一个游戏在多个来源里只占一个名额。
 */
export const QUOTAS = { trendRank: 130, soonRank: 100, newRank: 45, wishRank: 25 };
export function buildPool(entries, limit = POOL_LIMIT, quotas = QUOTAS) {
  const picked = new Map();
  for (const e of entries) if (e.own || e.manual || e.wasHot) picked.set(e.appid, e);
  for (const [key, quota] of Object.entries(quotas)) {
    let n = 0;
    for (const e of entries.filter((x) => x[key] != null).sort((a, b) => a[key] - b[key])) {
      if (picked.size >= limit || n >= quota) break;
      if (!picked.has(e.appid)) picked.set(e.appid, e);
      n += 1;
    }
  }
  const best = (e) => Math.min(...Object.keys(quotas).map((k) => e[k] ?? 9999));
  for (const e of [...entries].sort((a, b) => best(a) - best(b))) {
    if (picked.size >= limit) break;
    if (!picked.has(e.appid)) picked.set(e.appid, e);
  }
  return [...picked.values()].slice(0, Math.max(limit, 0));
}

// ─── 信息源 ───────────────────────────────────────────────────────────────────

async function storeQuery(sort, count) {
  const input = { query: { start: 0, count, sort, filters: { coming_soon_only: true, type_filters: { include_games: true } } }, context: { language: 'english', country_code: 'US' }, data_request: { include_basic_info: true } };
  const d = JSON.parse(await getText(`https://api.steampowered.com/IStoreQueryService/Query/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`));
  return (d?.response?.ids || []).map((x) => x.appid);
}

async function searchPages(filter, pages) {
  const out = [];
  for (let p = 0; p < pages; p += 1) {
    const d = JSON.parse(await getText(`https://store.steampowered.com/search/results/?filter=${filter}&infinite=1&count=100&start=${p * 100}&cc=us&l=english&category1=998`));
    out.push(...parseSearchHtml(d.results_html || ''));
    await sleep(1000);
  }
  return out;
}

async function getItems(appids) {
  const out = {};
  for (let i = 0; i < appids.length; i += 100) {
    const input = { ids: appids.slice(i, i + 100).map((appid) => ({ appid })), context: { language: 'english', country_code: 'US' }, data_request: { include_release: true } };
    try {
      const d = JSON.parse(await withRetry(() => getText(`https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`)));
      for (const it of d?.response?.store_items || []) {
        if (it.success !== 1) continue;
        out[it.appid || it.id] = { name: it.name, type: it.type, release: describeRelease(it.release || {}, it.is_coming_soon) };
      }
    } catch {
      // 这一批拿不到名字 / 发售日，用信息源里的
    }
    await sleep(500);
  }
  return out;
}

/** 自家站：Ship/<站>/src 里出现最多的 Steam appid */
function ownSiteApps() {
  const out = {};
  for (const dir of readdirSync(SHIP, { withFileTypes: true })) {
    if (!dir.isDirectory() || dir.name.startsWith('.') || dir.name === 'game-name-radar') continue;
    const src = path.join(SHIP, dir.name, 'src');
    if (!existsSync(src)) continue;
    let text = '';
    try {
      text = execFileSync('grep', ['-rhoE', 'store\\.steampowered\\.com/app/[0-9]+', src], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    } catch {
      continue; // grep 没命中退出码 1
    }
    const counts = {};
    for (const m of text.matchAll(/app\/(\d+)/g)) counts[m[1]] = (counts[m[1]] || 0) + 1;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (top) out[Number(top[0])] = dir.name;
  }
  return out;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function wishlistApps() {
  const c = await readJson(candidatesPath, []);
  const arr = Array.isArray(c) ? c : c.candidates || Object.values(c);
  const out = [];
  for (const x of arr) {
    const s = (x.sources || []).find((s) => s.sourceId === 'steam-top-wishlist');
    const appid = Number(s?.url?.match(/\/app\/(\d+)/)?.[1]);
    if (!appid || Date.now() - Date.parse(s.lastSeen || 0) > 3 * DAY) continue;
    out.push({ appid, name: x.gameName, rank: s.currentRank ?? 999 });
  }
  return out;
}

/** 单次请求（不重试）：成功返回数字，失败抛 Error（message 带 HTTP 状态，限流时是 429） */
async function fetchFollowersOnce(appid) {
  const n = parseMemberCount(await getText(`https://steamcommunity.com/games/${appid}/memberslistxml/?xml=1`, 20_000));
  if (n === null) throw new Error('no memberCount');
  return n;
}

/**
 * 批量抓关注者。steamcommunity 按出口 IP 限流（10-12 实测：1.1 秒一个，连续 100 多次后 429；2 秒一个第 60 次 429；
 * 单独重试又都成功），所以：每个间隔 4 秒；连续失败 3 次 = 被限流了 → 歇 150 秒再继续；最后把失败的再补一轮。
 * 总耗时到 deadline 就停（没抓到的明天排前面，曲线允许隔天采样）。ids 要按优先级排好。
 */
export async function fetchAllFollowers(appids, { gap = GAP_MS, cooldownMs = 150_000, deadline = Date.now() + MAX_MINUTES * 60_000, log = () => {} } = {}) {
  const out = new Map();
  const errors = {};
  let requests = 0;
  let cooldowns = 0;
  let timedOut = false;
  const pass = async (ids) => {
    let streak = 0;
    for (const [i, appid] of ids.entries()) {
      if (Date.now() > deadline) {
        timedOut = true;
        return;
      }
      try {
        requests += 1;
        out.set(appid, await fetchFollowersOnce(appid));
        streak = 0;
      } catch (error) {
        const kind = String(error.message).replace(/^HTTP /, '').slice(0, 20);
        errors[kind] = (errors[kind] || 0) + 1;
        streak += 1;
        if (streak >= 3) {
          cooldowns += 1;
          log(`  连续失败 ${streak} 次（${kind}），歇 ${cooldownMs / 1000} 秒（第 ${cooldowns} 次）…`);
          await sleep(cooldownMs);
          streak = 0;
        }
      }
      if ((i + 1) % 50 === 0) log(`  关注者 ${i + 1}/${ids.length}（成功 ${out.size}）`);
      await sleep(gap);
    }
  };
  await pass(appids);
  const missing = appids.filter((id) => !out.has(id));
  if (missing.length && !timedOut) {
    log(`  补抓失败的 ${missing.length} 个…`);
    await sleep(cooldownMs);
    await pass(missing);
  }
  return { followers: out, requests, errors, cooldowns, timedOut };
}

async function fetchFollowers(appid) {
  return withRetry(() => fetchFollowersOnce(appid), 2);
}

/** 每天必抓的：自家站 / 手动 / 之前报过 / 热度榜前 60 / 即将推出前 40 */
export const mustFetch = (e) => Boolean(e.own || e.manual || e.wasHot || (e.trendRank ?? 999) <= 60 || (e.soonRank ?? 999) <= 40);

/** 收集今天的池子（只返回候选，不抓关注者） */
async function collectPool(state, config) {
  const errors = [];
  const today = localDate();
  const entries = new Map();
  const add = (appid, patch) => {
    if (!appid) return;
    const e = entries.get(appid) || { appid, sources: [] };
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'source') e.sources.push(v);
      else if (e[k] == null) e[k] = v;
    }
    entries.set(appid, e);
  };

  const own = ownSiteApps();
  for (const [appid, site] of Object.entries(own)) add(Number(appid), { own: site, source: `自家站 ${site}` });
  for (const appid of config.watch || []) add(Number(appid), { manual: true, source: '手动名单' });
  for (const [appid, g] of Object.entries(state.games || {})) {
    if (g.alertedAt && Date.now() - Date.parse(g.alertedAt) < 30 * DAY) add(Number(appid), { wasHot: true, name: g.name, source: '之前报过' });
  }
  try {
    (await withRetry(() => storeQuery(20, 200))).forEach((appid, i) => add(appid, { trendRank: i + 1, source: `即将推出热度榜 #${i + 1}` }));
  } catch (error) {
    errors.push(`即将推出热度榜：${error.message}`);
  }
  try {
    for (const [i, r] of (await searchPages('popularcomingsoon', 4)).entries()) {
      const date = parseReleaseText(r.releaseText);
      if (date && daysBetween(today, date) >= 0 && daysBetween(today, date) <= WINDOW_DAYS) add(r.appid, { soonRank: i + 1, name: r.name, source: `热门即将推出 #${i + 1}` });
    }
  } catch (error) {
    errors.push(`热门即将推出：${error.message}`);
  }
  try {
    for (const [i, r] of (await searchPages('popularnew', 3)).entries()) {
      const date = parseReleaseText(r.releaseText);
      if (date && daysBetween(date, today) >= 0 && daysBetween(date, today) <= WINDOW_DAYS) add(r.appid, { newRank: i + 1, name: r.name, source: `热门新品 #${i + 1}` });
    }
  } catch (error) {
    errors.push(`热门新品：${error.message}`);
  }
  for (const w of await wishlistApps()) add(w.appid, { wishRank: w.rank, name: w.name, source: `热门愿望单 #${w.rank}` });

  // 统一拿名字 / 类型 / 发售日；DLC、原声、发售超过 30 天的移出（自家站 / 手动除外）
  const info = await getItems([...entries.keys()]);
  const kept = [];
  for (const e of entries.values()) {
    const it = info[e.appid];
    if (it) Object.assign(e, { name: it.name || e.name, release: it.release, type: it.type });
    if (!e.name) continue;
    if (!e.manual && it && it.type !== 0) continue; // 0 = 游戏；自家站源码里偶尔链到 DLC / 素材包
    if (!(e.own || e.manual)) {
      if (e.release && !e.release.comingSoon && e.release.date && daysBetween(e.release.date, today) > WINDOW_DAYS) continue;
    }
    kept.push(e);
  }
  return { entries: kept, total: entries.size, errors };
}

const LABEL = { go: '🟢 起量', sprout: '🌱 小而快', big: '🔵 大作', rising: '🟡 在涨', flat: '⚪ 平', new: '⚪ 新进池' };

export async function runSteamFollowWatch({ limit = POOL_LIMIT, dryRun = false } = {}) {
  const started = Date.now();
  const today = localDate();
  const state = await readJson(statePath, { games: {} });
  state.games ||= {};
  const config = await readJson(configPath, { watch: [] });
  const firstRun = !state.lastRun;

  const { entries, total, errors } = await collectPool(state, config);
  const pool = buildPool(entries, limit);
  const log = (m) => process.stderr.write(`${m}\n`);
  log(`Steam 关注者雷达：池子 ${pool.length} 个，开始抓关注者…`);
  // 抓的顺序：自家站 / 手动 / 之前报过 / 热度榜前 60 / 即将推出前 40 先抓（每天都要有数），
  // 其余按「上次抓到的日期」从旧到新轮换（今天被限流没抓到的，明天排前面）
  const lastFetched = (e) => state.games[e.appid]?.history?.at(-1)?.date || '0000';
  const order = [...pool].sort((a, b) => Number(!mustFetch(a)) - Number(!mustFetch(b)) || lastFetched(a).localeCompare(lastFetched(b)));
  const fetched = await fetchAllFollowers(order.map((e) => e.appid), { log });
  const { requests } = fetched;
  let failed = 0;
  const rows = [];
  for (const e of pool) {
    const g = (state.games[e.appid] ||= { name: e.name, firstSeen: today, history: [] });
    // 今天这一轮没抓到、但今天早些时候（上一个时间点重试）已经抓到过的，照样算今天有数
    const followers = fetched.followers.get(e.appid) ?? g.history.find((h) => h.date === today)?.followers ?? null;
    if (followers === null) failed += 1;
    Object.assign(g, { name: e.name, release: e.release || g.release, sources: e.sources, own: e.own || null, lastInPool: today });
    if (followers !== null) g.history = [...g.history.filter((h) => h.date !== today), { date: today, followers }].slice(-60);
    const stats = followerStats(g.history);
    // 今天没抓到（限流 / 到时间上限）：用之前的曲线，不下新判决
    const verdict = followers === null ? 'error' : judgeFollow(stats);
    const hot = ['go', 'sprout'].includes(verdict);
    const isNewAlert = hot && !g.alertedAt;
    if (hot) g.alertedAt ||= new Date().toISOString();
    rows.push({ ...e, ...g, stats, verdict, isNewAlert });
  }

  // 30 天没进池子的游戏从状态里清掉
  for (const [appid, g] of Object.entries(state.games)) {
    if (daysBetween(g.lastInPool || g.firstSeen, today) > 30) delete state.games[appid];
  }

  const hotNames = rows.filter((r) => ['go', 'sprout'].includes(r.verdict)).map((r) => r.name);
  const nrd = hotNames.length ? await nrdCounts(hotNames) : { available: false, byName: {}, dates: [] };
  const meta = { date: today, firstRun, poolSize: pool.length, candidates: total, eligible: entries.length, requests, failed, fetchErrors: fetched.errors, cooldowns: fetched.cooldowns, timedOut: fetched.timedOut, errors, seconds: Math.round((Date.now() - started) / 1000), nrd };
  if (!dryRun) {
    state.lastRun = new Date().toISOString();
    await fs.writeFile(statePath, JSON.stringify(state, null, 2) + '\n');
    await fs.writeFile(reportPath(`RADAR-STEAMFOLLOW-${today}.md`), renderReport(rows, meta));
  }
  return { rows, ...meta };
}

const pct = (g) => (g === null || g === undefined ? '-' : `${g >= 0 ? '+' : ''}${(g * 100).toFixed(g !== 0 && Math.abs(g) < 0.1 ? 1 : 0)}%`);
const storeLink = (r) => `[${String(r.name).replace(/[|[\]]/g, ' ')}](https://store.steampowered.com/app/${r.appid}/)`;

function releaseCell(r, today) {
  const rel = r.release;
  if (!rel) return '?';
  if (rel.date) {
    const d = daysBetween(today, rel.date);
    return d >= 0 ? `${rel.date}（${d} 天后）` : `${rel.date}（已发售 ${-d} 天）`;
  }
  return rel.text;
}

export function renderReport(rows, meta) {
  const { date, firstRun, poolSize, candidates, eligible, requests, failed, fetchErrors = {}, cooldowns = 0, timedOut = false, errors, seconds, nrd } = meta;
  const order = ['go', 'sprout', 'big', 'rising', 'new', 'flat', 'error'];
  const sorted = [...rows].sort((a, b) => order.indexOf(a.verdict) - order.indexOf(b.verdict) || (b.stats?.daily ?? -1) - (a.stats?.daily ?? -1));
  const growthCell = (s) => (s?.growth7 === null || s?.growth7 === undefined ? '-' : `${pct(s.growth7)}${s.estimated ? `（估，${s.spanDays} 天）` : ''}`);
  const dailyCell = (s) => (s?.daily === null || s?.daily === undefined ? '-' : `${s.daily >= 0 ? '+' : ''}${Math.round(s.daily)}`);
  const lines = [
    `# Steam 关注者增速雷达 ${date}`,
    '',
    '> `game-name-radar/lib/steam-follow-watch.mjs` · 预发布 / 刚发售（±30 天）游戏每天记一次 Steam 社区关注者数，看谁在加速 · 零额度',
    '',
    `池子 ${poolSize} 个（信息源合计 ${candidates} 个，过滤后 ${eligible} 个，上限 ${POOL_LIMIT}）· 今天抓到 ${poolSize - failed} 个 · 关注者请求 ${requests} 次（最终失败 ${failed}${Object.keys(fetchErrors).length ? `，中途错误 ${Object.entries(fetchErrors).map(([k, v]) => `${k}×${v}`).join(' ')}` : ''}${cooldowns ? `，限流歇了 ${cooldowns} 次` : ''}${timedOut ? `，到 ${MAX_MINUTES} 分钟上限停了，没抓到的明天优先` : ''}）· 耗时 ${Math.round(seconds / 60)} 分钟`,
    '',
    `判决：🟢 起量 = 日增 ≥${RULES.go.daily} 且 7 天增长 ≥${RULES.go.growth7 * 100}%（关注者 <5 万）· 🌱 小而快 = 关注者 <${RULES.sprout.maxFollowers}、日增 ≥${RULES.sprout.daily} 且 7 天增长 ≥${RULES.sprout.growth7 * 100}% · 🔵 大作 = ≥5 万且日增 ≥${RULES.big.daily}（只做参考）· 🟡 在涨 = 日增 ≥${RULES.rising.daily} 或 7 天 ≥${RULES.rising.growth7 * 100}%。`,
    '依据：愿望单 ≈ 关注者 × 7–10（独立游戏圈经验），100 关注/天 ≈ 上「即将推出」首页的独立游戏量级。曲线不足 7 天时 7 天增长按已有天数折算（标「估」），至少 2 天曲线才下判决。',
    '',
  ];
  if (firstRun) lines.push('> ⚠️ 首次运行 = 只建曲线：每个游戏今天只有一个数，算不出增长，明天起才有日增，满 7 天才有真实的 7 天增长。', '');
  if (errors.length) lines.push(`> 信息源失败：${errors.join('；')}`, '');

  const hot = sorted.filter((r) => ['go', 'sprout', 'big', 'rising'].includes(r.verdict));
  if (hot.length) {
    lines.push('| 判决 | 游戏 | 关注者 | 日增 | 7 天增长 | 发售 | 新注册域名 | 来源 |', '|---|---|---|---|---|---|---|---|');
    for (const r of hot.slice(0, 40)) {
      const domains = ['go', 'sprout'].includes(r.verdict) && nrd.available ? nrdNote(nrd.byName[r.name], { days: nrd.dates.length }) : '-';
      lines.push(`| ${LABEL[r.verdict]}${r.isNewAlert ? ' 🆕' : ''} | ${storeLink(r)} | ${r.stats?.followers ?? '-'} | ${dailyCell(r.stats)} | ${growthCell(r.stats)} | ${releaseCell(r, date)} | ${domains} | ${(r.sources || []).slice(0, 2).join('，')} |`);
    }
    lines.push('');
  } else if (!firstRun) {
    lines.push('今天没有在加速的游戏。', '');
  }

  const own = sorted.filter((r) => r.own);
  if (own.length) {
    lines.push('### 自家站的游戏', '', '| 站 | 游戏 | 关注者 | 日增 | 7 天增长 | 发售 |', '|---|---|---|---|---|---|');
    for (const r of own) lines.push(`| ${r.own} | ${storeLink(r)} | ${r.stats?.followers ?? '-'} | ${dailyCell(r.stats)} | ${growthCell(r.stats)} | ${releaseCell(r, date)} |`);
    lines.push('');
  }

  const rest = sorted.filter((r) => !r.own && !['go', 'sprout', 'big', 'rising'].includes(r.verdict));
  if (rest.length) {
    lines.push(`<details><summary>其余 ${rest.length} 个（${firstRun ? '今天刚建曲线' : '没在加速 / 刚进池'}）</summary>`, '');
    lines.push(rest.slice(0, 200).map((r) => `${r.name}（${r.verdict === 'error' ? '今天没抓到' : r.stats?.followers ?? '-'}${r.verdict !== 'error' && r.stats?.daily != null ? ` ${dailyCell(r.stats)}/天` : ''}）`).join(' · '), '', '</details>', '');
  }
  lines.push('下一步（🟢 / 🌱）：①`node radar.mjs check "<游戏名>"` 过工具闸门 + 投入价值 ②看「新注册域名」：⚠️ = 同行在抢，要么当天买要么放弃 ③发售日前 1–2 周是建站最佳时点（发售当天搜索才爆）');
  return lines.join('\n') + '\n';
}

const IS_MAIN = import.meta.url === `file://${process.argv[1]}` || Boolean(process.argv[1]?.endsWith('steam-follow-watch.mjs'));
if (IS_MAIN) {
  const args = process.argv.slice(2);
  const ids = args.filter((a) => /^\d+$/.test(a)).map(Number);
  if (ids.length) {
    const info = await getItems(ids);
    for (const id of ids) {
      let n = null;
      try { n = await fetchFollowers(id); } catch {}
      console.log(`${id} ${info[id]?.name ?? '?'}：关注者 ${n ?? '失败'} · 发售 ${info[id]?.release?.text ?? '?'}`);
      await sleep(GAP_MS);
    }
  } else {
    const limitArg = args.find((a) => a.startsWith('--limit='));
    const r = await runSteamFollowWatch({ limit: limitArg ? Number(limitArg.split('=')[1]) : POOL_LIMIT, dryRun: Boolean(limitArg) || args.includes('--dry-run') });
    const count = (v) => r.rows.filter((x) => x.verdict === v).length;
    console.log(`Steam 关注者雷达：池子 ${r.poolSize}（候选 ${r.candidates} → 合格 ${r.eligible}）· 请求 ${r.requests}（失败 ${r.failed}）· ${r.seconds}s · 🟢 ${count('go')} · 🌱 ${count('sprout')} · 🔵 ${count('big')} · 🟡 ${count('rising')}${r.firstRun ? '（首次建曲线）' : ''}${r.errors.length ? `；源失败 ${r.errors.join('；')}` : ''}`);
    for (const x of r.rows.filter((x) => ['go', 'sprout'].includes(x.verdict)).slice(0, 10)) console.log(`  ${LABEL[x.verdict]} ${x.name}：${x.stats.followers}（+${Math.round(x.stats.daily)}/天，7 天 ${pct(x.stats.growth7)}）`);
    if (args.includes('--dry-run') || limitArg) {
      console.log('（试跑：不写状态 / 报告）');
      for (const x of r.rows.slice(0, 30)) console.log(`  ${x.appid} ${x.name} · ${x.stats?.followers ?? '失败'} · ${x.release?.text ?? '?'} · ${(x.sources || []).join('，')}`);
    }
  }
}
