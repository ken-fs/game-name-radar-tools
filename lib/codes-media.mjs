#!/usr/bin/env node
/**
 * codes-media.mjs — 「<游戏> codes」Google 美国前 10 里有几家大媒体（2026-10-13 加）
 *
 * 为什么需要：Ship/research/GAME-WIKI-STRUCTURE-2026-10.md 查了 33 个「<游戏> codes」结果页，
 * 31 个前 5 有大媒体（GameRant / Beebom / IGN…）。媒体一铺开，独立站的 codes 页就进不去前 10；
 * 独立站只在刚出的小游戏上拿到过（Pets Universe #3、Race for Eggs #7）。
 * 所以 codes 能不能当主打，看的是「媒体来了几家」，不是 codes 词热不热。
 *
 * 规则：0–1 家 = 📣 codes 还有窗口（抢速度）· 2 家 = 🟡 · ≥3 家 = ⛔ codes 别当主打（做实体页 / 工具页）
 *
 * ⚠️ treg 这个路由（crawl4ai 抓 Google）有时返回模糊匹配的结果页——查 pets universe codes
 * 回来的是 Clicking Universe / Collect All Pets 一堆别的游戏。所以只数**标题含游戏名**的结果；
 * 含游戏名的不到 3 条 = 「SERP 错配」，不报 0 家（不然会把错配当成蓝海）。
 *
 * 花钱：treg `treg.google.serp.organic` 约 $0.00015/次；只查「今天最值得看」的候选，每天最多 15 次新查询
 * （按 data/codes-media-spend.jsonl 当天记账算），结果按游戏缓存 3 天（data/codes-media-cache.json）。
 * token 读 TREG_TOKEN 环境变量或 ~/.config/treg/env，绝不打印。
 *
 * 用法：node lib/codes-media.mjs "Blox Fruits" "Pets Universe"      # 单查（也受每日上限和缓存约束）
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normName } from './tool-demand.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = join(HERE, '..', 'data', 'codes-media-cache.json');
const SPEND_FILE = join(HERE, '..', 'data', 'codes-media-spend.jsonl');
const TTL = 3 * 86400_000;
export const DAILY_CAP = 15;

export const MEDIA_DOMAINS = [
  'gamerant.com', 'beebom.com', 'ign.com', 'pcgamesn.com', 'dexerto.com', 'pockettactics.com', 'destructoid.com',
  'bluestacks.com', 'game8.co', 'radiotimes.com', 'eurogamer.net', 'gamesradar.com', 'sportskeeda.com',
  'progameguides.com', 'twinfinite.net', 'urgametips.com', 'tryhardguides.com', 'thegamer.com', 'polygon.com',
  'rockpapershotgun.com', 'siliconera.com',
];

const mediaOf = (domain = '') => {
  const d = String(domain).toLowerCase().replace(/^www\./, '');
  return MEDIA_DOMAINS.find((m) => d === m || d.endsWith(`.${m}`)) || null;
};

/** 标题含游戏名（大小写 / 标点归一；名字够长时也认去空格的写法，如 BloxFruits） */
export function titleMentions(game, title) {
  const name = normName(game);
  const t = normName(title);
  if (!name) return false;
  if (` ${t} `.includes(` ${name} `)) return true;
  const compact = name.replace(/ /g, '');
  return compact.length >= 8 && t.replace(/ /g, '').includes(compact);
}

/** 纯函数：结果页 → { relevant, media: [域名], verdict, label } */
export function classifyCodesSerp(game, results) {
  const relevant = (results || []).filter((r) => titleMentions(game, r.title));
  if (relevant.length < 3) {
    return { relevant: relevant.length, total: (results || []).length, media: [], verdict: 'mismatch', label: `SERP 错配（前 ${(results || []).length} 条只有 ${relevant.length} 条讲这个游戏）` };
  }
  const media = [...new Set(relevant.map((r) => mediaOf(r.domain || safeHost(r.url))).filter(Boolean))];
  const n = media.length;
  const verdict = n <= 1 ? 'open' : n === 2 ? 'mixed' : 'closed';
  const label = {
    open: `📣 codes 媒体 ${n} 家 · codes 还有窗口（抢速度）`,
    mixed: `🟡 codes 媒体 ${n} 家`,
    closed: `⛔ codes 媒体 ${n} 家 · codes 别当主打（做实体页 / 工具页）`,
  }[verdict];
  // top：讲这个游戏的结果都是谁（排查用，报告里不展示）
  const top = relevant.map((r) => String(r.domain || safeHost(r.url)).replace(/^www\./, ''));
  return { relevant: relevant.length, total: results.length, media, verdict, label, top };
}

function safeHost(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function readJson(file, fallback) {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback; } catch { return fallback; }
}

function tregToken() {
  if (process.env.TREG_TOKEN) return process.env.TREG_TOKEN.trim();
  try {
    const line = readFileSync(join(homedir(), '.config', 'treg', 'env'), 'utf8').split('\n').find((l) => l.startsWith('TREG_TOKEN='));
    return line ? line.slice('TREG_TOKEN='.length).trim().replace(/^["']|["']$/g, '') : '';
  } catch {
    return '';
  }
}

const today = () => new Date().toLocaleDateString('sv-SE');

/** 当天已花的新查询次数（跨进程：radar.mjs 重跑 / 手动 check 都记在同一本账上） */
function callsToday() {
  if (!existsSync(SPEND_FILE)) return 0;
  const d = today();
  return readFileSync(SPEND_FILE, 'utf8').split('\n').filter((l) => l.includes(`"date":"${d}"`)).length;
}

async function fetchSerp(game, token) {
  const res = await fetch('https://treg.to/call/treg.google.serp.organic', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Treg-Token': token, 'X-Treg-Route-Max-Cost': '0.01' },
    body: JSON.stringify({ q: `${game.toLowerCase()} codes`, country: 'us', language: 'en', limit: 10 }),
    signal: AbortSignal.timeout(90_000),
  });
  const costMicro = Number(res.headers.get('x-treg-cost-micro') || 0);
  appendFileSync(SPEND_FILE, JSON.stringify({ date: today(), at: new Date().toISOString(), game, status: res.status, costMicro, provider: res.headers.get('x-treg-served-by') || '' }) + '\n');
  if (!res.ok) throw new Error(`treg HTTP ${res.status}`);
  const data = await res.json();
  const results = data?.output?.results;
  if (!Array.isArray(results)) throw new Error('treg 返回里没有 output.results');
  return { results, costMicro };
}

/**
 * 批量查（按传入顺序，越靠前越优先占当天额度）。返回 Map<名字, 结果>；
 * 结果 = classifyCodesSerp 的输出 + { cached, checkedAt }，或 { verdict:'failed'|'skipped', label }。永不抛。
 */
export async function codesMediaBatch(names, { maxCalls = DAILY_CAP } = {}) {
  const out = new Map();
  const cache = readJson(CACHE_FILE, {});
  const token = tregToken();
  let budget = Math.max(0, Math.min(maxCalls, DAILY_CAP - callsToday()));
  let spent = 0;
  let calls = 0;
  for (const game of [...new Set(names.filter(Boolean))]) {
    const key = normName(game);
    const hit = cache[key];
    if (hit && Date.now() - Date.parse(hit.checkedAt) < TTL) { out.set(game, { ...hit, cached: true }); continue; }
    if (!token) { out.set(game, { verdict: 'failed', label: 'codes 媒体 查询失败（没有 TREG_TOKEN）' }); continue; }
    if (budget <= 0) { out.set(game, { verdict: 'skipped', label: `codes 媒体 没查（今天 ${DAILY_CAP} 次额度用完）` }); continue; }
    budget -= 1;
    calls += 1;
    try {
      const { results, costMicro } = await fetchSerp(game, token);
      spent += costMicro;
      const r = { ...classifyCodesSerp(game, results), checkedAt: new Date().toISOString() };
      cache[key] = r;
      out.set(game, r);
    } catch (error) {
      out.set(game, { verdict: 'failed', label: `codes 媒体 查询失败（${String(error.message).slice(0, 60)}）` });
    }
  }
  // 错配也缓存 3 天（同一个词 Google 短期内不会变准）；失败不缓存，下次重试
  for (const [k, v] of Object.entries(cache)) if (Date.now() - Date.parse(v.checkedAt) > TTL) delete cache[k];
  try { writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2) + '\n'); } catch { /* 缓存写不进不影响结果 */ }
  if (calls) console.error(`codes 媒体：新查 ${calls} 次，花费 $${(spent / 1e6).toFixed(5)}（记账 data/codes-media-spend.jsonl）`);
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
