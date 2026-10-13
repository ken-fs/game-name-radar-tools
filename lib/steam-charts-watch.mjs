#!/usr/bin/env node
/**
 * steam-charts-watch.mjs — Steam 畅销 / 在玩榜新上榜（2026-10-13 加）
 *
 * 为什么需要（全雷达复盘 REVIEW-2026-10-12 的盲区）：用户自己建了 dressmaker.life（10-03）、graveyardkeeper2.live（10-04）、
 * thebloodofdawnwalker.xyz（10-02），三个 Steam 游戏没有任何雷达报过。现有 Steam 源只看「热门愿望单 / 热门新品 / 最新独立」，
 * **没有畅销榜和在玩榜** —— 发售后靠口碑冲上来的游戏（Dressmaker 发售第一周冲到全球周畅销 #12）全漏了。
 *
 * 信息源（全部 Steam 官方、免费、无 key，10-13 实测直连和代理都通）：
 *   ① 周畅销 IStoreTopSellersService/GetWeeklyTopSellers（全球 + 美 / 德 / 日，各前 100）
 *      自带 last_week_rank / consecutive_weeks，还能按 start_date 查历史周 → 首次运行就能回补前两周做对比，也能回测。
 *      ⚠️ 周榜按「周二 00:00 UTC」开周，**滞后约一周**（10-13 拿到的最新一周是 09-29 那周）。
 *   ② 在玩榜 ISteamChartsService/GetMostPlayedGames（前 100，按日更新的峰值在线，自带 last_week_rank）
 *   ③ 实时畅销 store.steampowered.com/search/?filter=topsellers（美 / 德 / 日各前 100，当前时刻的畅销排序，
 *      补周榜的一周滞后；没有上周名次，靠本模块每天的快照比）
 *   × ISteamChartsService/GetTopReleasesPages：最新一页停在 2025-02，已经不更新了，不用。
 *   名字 / 类型 / 发售日 / 标签统一用 IStoreBrowseService/GetItems 批量拿（100 个一次，缓存 7 天），标签名用 IStoreService/GetTagList。
 *
 * 每天把各榜名次记进 data/steam-charts-state.json，挑出：
 *   - 🆕 新上榜：前 14 天（周榜 = 前两周）的快照里都不在前 100，榜单自带的上周名次也不在前 100
 *   - ⬆️ 冲榜：比上一次的名次（周榜看上周、日榜看 7 天内最好的一次，以及榜单自带的上周名次）上升 ≥30 名
 *   并且 **发售 ≤45 天，或 7 天内就发售**（预购冲畅销榜）—— CS2 / Dota 这种常青游戏靠发售日过滤掉。
 *   精确到日的发售日才算（「Q4 2026」「Coming soon」不算）。
 *
 * 判决：
 *   🟢 冲榜   有一个榜进了前 50（周畅销 / 实时畅销 / 在玩榜任一）且 发售 ≤30 天或 7 天内发售
 *   🌱 上榜   其余满足上面条件的（名次 51–100，或发售 31–45 天）
 *   一个游戏在多个榜上合成一行。实时畅销第一次运行只建基线（没有昨天可比）。
 *
 * 每条加注（照 steam-follow-watch 的做法，不重复写闸门逻辑）：
 *   - 新注册域名（lib/nrd.mjs，本地文件）：🟢 / 🌱 全部
 *   - 🧮 工具需求（lib/tool-demand.mjs，Google Suggest，缓存 24h）：前 12 个
 *   - 投入价值（lib/invest-score.mjs 原样调用，零额度）：🟢 前 5 个；每日管线 3 天内评过的直接用，本模块评过的 20h 内不重评
 *
 * 用法：
 *   node lib/steam-charts-watch.mjs                     # 跑一轮，写 ../RADAR-STEAMCHARTS-<日期>.md
 *   node lib/steam-charts-watch.mjs --dry-run           # 只打印，不写状态和报告
 *   node lib/steam-charts-watch.mjs --week=2026-09-22   # 回测：只用那一周（及前两周）的周畅销榜，按那周结束时的日期判，不写任何东西
 *   不推通知：🟢 进 radar.mjs 的「今天最值得看」，由总报告统一推。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nrdCounts, nrdNote } from './nrd.mjs';
import { toolDemand, toolDemandNote } from './tool-demand.mjs';
import { investScore, appIdFromCandidate, VERDICT_LABEL } from './invest-score.mjs';
import { describeRelease, parseSearchHtml } from './steam-follow-watch.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIP = path.join(root, '..');
const statePath = path.join(root, 'data', 'steam-charts-state.json');
const candidatesPath = path.join(root, 'data', 'candidates.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';

const DAY = 864e5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const localDate = (d = new Date()) => d.toLocaleDateString('sv-SE');
const isoDay = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

export const RULES = {
  top: 100, // 只看前 100
  newLookbackDays: 14, // 前 14 天都不在前 100 = 新上榜
  jump: 30, // 上升 ≥30 名 = 冲榜
  maxAgeDays: 45, // 发售超过 45 天的不报
  maxUpcomingDays: 7, // 7 天内发售的（预购冲榜）也报
  goRank: 50, // 🟢 要有一个榜进前 50
  goAgeDays: 30, // 🟢 要发售 ≤30 天（或 7 天内发售）
};
const TOOL_LIMIT = 12;
const INVEST_LIMIT = 5;

export const CHARTS = [
  { id: 'weekly-global', label: '全球周畅销', kind: 'weekly', cc: null },
  { id: 'weekly-us', label: '美国周畅销', kind: 'weekly', cc: 'US' },
  { id: 'weekly-de', label: '德国周畅销', kind: 'weekly', cc: 'DE' },
  { id: 'weekly-jp', label: '日本周畅销', kind: 'weekly', cc: 'JP' },
  { id: 'mostplayed', label: '在玩榜', kind: 'mostplayed' },
  { id: 'live-us', label: '美国实时畅销', kind: 'search', cc: 'us' },
  { id: 'live-de', label: '德国实时畅销', kind: 'search', cc: 'de' },
  { id: 'live-jp', label: '日本实时畅销', kind: 'search', cc: 'jp' },
];

async function getText(url, timeout = 30_000) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** 代理今天抖过（10-13）：每个请求最多 3 次 */
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

const api = (iface, input) => `https://api.steampowered.com/${iface}/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`;

// ─── 解析（纯函数，有测试）─────────────────────────────────────────────────────

/** GetWeeklyTopSellers → { key: 周一开始日期, ranks: [{ appid, rank, lastWeekRank, weeks, name }] } */
export function parseWeekly(json) {
  const r = json?.response;
  if (!r?.ranks?.length) return null;
  return {
    key: isoDay(r.start_date),
    ranks: r.ranks.map((x) => ({ appid: x.appid, rank: x.rank, lastWeekRank: x.last_week_rank ?? null, weeks: x.consecutive_weeks ?? null, name: x.item?.name ?? null })),
  };
}

/** GetMostPlayedGames → { key: 统计日期, ranks: [{ appid, rank, lastWeekRank, peak }] } */
export function parseMostPlayed(json) {
  const r = json?.response;
  if (!r?.ranks?.length) return null;
  return { key: isoDay(r.rollup_date), ranks: r.ranks.map((x) => ({ appid: x.appid, rank: x.rank, lastWeekRank: x.last_week_rank || null, peak: x.peak_in_game ?? null })) };
}

/**
 * 一个榜的当前名次 vs 历史快照 → 上榜信号。
 *   snapshots: { [key]: { [appid]: rank } }（不含本次）；key 是日期，周榜是开周日期
 *   返回 Map<appid, { rank, prevRank, signal: 'new' | 'jump' }>；没有任何对比依据（第一次跑、榜单也没给上周名次）的不出信号
 */
export function chartSignals(current, snapshots = {}, { key, rules = RULES } = {}) {
  const prior = Object.keys(snapshots).filter((k) => k < key && daysBetween(k, key) <= rules.newLookbackDays).sort();
  const recent = prior.filter((k) => daysBetween(k, key) <= 7);
  const out = new Map();
  for (const x of current) {
    if (x.rank > rules.top) continue;
    const hasApiPrev = x.lastWeekRank !== undefined; // 榜单自带上周名次（null = 上周不在榜上）
    if (!prior.length && !hasApiPrev) continue; // 没有可比的：只建基线
    const seen = prior.some((k) => snapshots[k][x.appid] != null && snapshots[k][x.appid] <= rules.top);
    const apiInTop = x.lastWeekRank != null && x.lastWeekRank <= rules.top;
    const prevs = [...recent.map((k) => snapshots[k][x.appid]), x.lastWeekRank].filter((v) => v != null);
    const prevRank = prevs.length ? Math.min(...prevs) : null;
    if (!seen && !apiInTop) out.set(x.appid, { rank: x.rank, prevRank, signal: 'new' });
    else if (prevRank != null && prevRank - x.rank >= rules.jump) out.set(x.appid, { rank: x.rank, prevRank, signal: 'jump' });
  }
  return out;
}

/** 发售日 → 离今天几天（正 = 已发售 N 天，负 = 还有 N 天发售）；不是精确日期 = null */
export function releaseAge(release, today) {
  return release?.date ? daysBetween(release.date, today) : null;
}

/** 在窗口里：发售 ≤45 天，或 7 天内就发售 */
export function inWindow(age, rules = RULES) {
  return age !== null && age <= rules.maxAgeDays && age >= -rules.maxUpcomingDays;
}

/** 一个游戏的全部上榜信号 → 判决 key（go / sprout），不在窗口里 = null */
export function judgeCharts(hits, age, rules = RULES) {
  if (!hits.length || !inWindow(age, rules)) return null;
  const strong = hits.some((h) => h.rank <= rules.goRank);
  return strong && age <= rules.goAgeDays ? 'go' : 'sprout';
}

/** 排序：🟢 在前；同档按「进前 50 的榜单数」多的在前（多国同时冲 = 不是单一市场现象），再按最好名次 */
export function compareRows(a, b) {
  const order = { go: 0, sprout: 1 };
  const strong = (r) => new Set(r.hits.filter((h) => h.rank <= RULES.goRank).map((h) => h.chart)).size;
  const best = (r) => Math.min(...r.hits.map((h) => h.rank));
  return order[a.verdict] - order[b.verdict] || strong(b) - strong(a) || best(a) - best(b);
}

// ─── 信息源 ───────────────────────────────────────────────────────────────────

async function fetchWeekly(cc, startDate = null) {
  const input = { context: { language: 'english', country_code: cc || 'US' }, page_start: 0, page_count: 100 };
  if (cc) input.country_code = cc; // 不带顶层 country_code = 全球榜（10-13 实测：带了名次就不一样）
  if (startDate) input.start_date = startDate;
  return parseWeekly(JSON.parse(await withRetry(() => getText(api('IStoreTopSellersService/GetWeeklyTopSellers', input)))));
}

async function fetchMostPlayed() {
  return parseMostPlayed(JSON.parse(await withRetry(() => getText('https://api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/'))));
}

async function fetchLive(cc, today) {
  const d = JSON.parse(await withRetry(() => getText(`https://store.steampowered.com/search/results/?filter=topsellers&infinite=1&count=100&start=0&cc=${cc}&l=english&category1=998`)));
  const rows = parseSearchHtml(d.results_html || '');
  if (!rows.length) throw new Error('空结果');
  return { key: today, ranks: rows.map((r, i) => ({ appid: r.appid, rank: i + 1, name: r.name })) };
}

async function tagNames(state) {
  if (state.tagNames && Date.now() - Date.parse(state.tagNamesAt || 0) < 7 * DAY) return state.tagNames;
  try {
    const d = JSON.parse(await withRetry(() => getText('https://api.steampowered.com/IStoreService/GetTagList/v1/?language=english')));
    state.tagNames = Object.fromEntries((d?.response?.tags || []).map((t) => [t.tagid, t.name]));
    state.tagNamesAt = new Date().toISOString();
  } catch {
    // 拿不到标签名就只显示不带标签
  }
  return state.tagNames || {};
}

/** 名字 / 类型 / 发售日 / 标签：缓存 7 天；还没发售的每天刷新（发售日会变） */
async function appInfo(appids, state) {
  state.apps ||= {};
  const stale = appids.filter((id) => {
    const a = state.apps[id];
    return !a || Date.now() - Date.parse(a.fetchedAt) > 7 * DAY || (a.release?.comingSoon && Date.now() - Date.parse(a.fetchedAt) > DAY);
  });
  for (let i = 0; i < stale.length; i += 100) {
    const input = { ids: stale.slice(i, i + 100).map((appid) => ({ appid })), context: { language: 'english', country_code: 'US' }, data_request: { include_release: true, include_tag_count: 6 } };
    try {
      const d = JSON.parse(await withRetry(() => getText(api('IStoreBrowseService/GetItems', input))));
      for (const it of d?.response?.store_items || []) {
        if (it.success !== 1) continue;
        state.apps[it.appid || it.id] = { name: it.name, type: it.type, release: describeRelease(it.release || {}, it.is_coming_soon), tagids: (it.tagids || []).slice(0, 6), fetchedAt: new Date().toISOString() };
      }
    } catch {
      // 这一批拿不到：沿用旧缓存，没有缓存的就当发售日未知（不报）
    }
    await sleep(500);
  }
  return state.apps;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 每日管线（scan.mjs）3 天内已经评过投入价值的 Steam 候选：appid → invest */
async function pipelineInvest() {
  const c = await readJson(candidatesPath, []);
  const arr = Array.isArray(c) ? c : c.candidates || Object.values(c);
  const out = new Map();
  for (const x of arr) {
    if (!x.invest || Date.now() - Date.parse(x.invest.checkedAt || 0) > 3 * DAY) continue;
    const id = Number(appIdFromCandidate(x));
    if (id) out.set(id, x.invest);
  }
  return out;
}

// ─── 主流程 ───────────────────────────────────────────────────────────────────

const snapshotOf = (chart) => Object.fromEntries(chart.ranks.map((x) => [x.appid, x.rank]));

/** 拉全部榜单（周榜顺手回补前两周快照），返回 { charts: {id: {key, ranks}}, errors } */
async function fetchCharts(state, today, { week = null } = {}) {
  state.charts ||= {};
  const charts = {};
  const errors = [];
  const weekStart = week ? Math.floor(Date.parse(`${week}T00:00:00Z`) / 1000) : null;
  for (const c of CHARTS) {
    if (week && c.kind !== 'weekly') continue;
    try {
      let cur;
      if (c.kind === 'weekly') cur = await fetchWeekly(c.cc, weekStart);
      else if (c.kind === 'mostplayed') cur = await fetchMostPlayed();
      else cur = await fetchLive(c.cc, today);
      if (!cur) throw new Error('空结果');
      charts[c.id] = cur;
      state.charts[c.id] ||= {};
      // 周榜：前两周不在快照里就补（首次运行 / 回测也能比「前 14 天」）
      if (c.kind === 'weekly') {
        for (const back of [7, 14]) {
          const k = new Date(Date.parse(cur.key) - back * DAY).toISOString().slice(0, 10);
          if (state.charts[c.id][k]) continue;
          try {
            const prev = await fetchWeekly(c.cc, Math.floor(Date.parse(`${k}T00:00:00Z`) / 1000));
            if (prev?.key === k) state.charts[c.id][k] = snapshotOf(prev);
          } catch {
            // 补不到就只用榜单自带的上周名次
          }
          await sleep(300);
        }
      }
    } catch (error) {
      errors.push(`${c.label}：${error.message}`);
    }
    await sleep(500);
  }
  return { charts, errors };
}

export async function runSteamChartsWatch({ dryRun = false, week = null } = {}) {
  const started = Date.now();
  // 回测：按那一周的数据「发布时」（开周 + 7 天）当今天
  const today = week ? new Date(Date.parse(week) + 7 * DAY).toISOString().slice(0, 10) : localDate();
  const state = await readJson(statePath, {});
  if (week) state.charts = structuredClone(state.charts || {}); // 回测不写盘，随便改
  const firstRun = !state.lastRun;
  const { charts, errors } = await fetchCharts(state, today, { week });

  // 各榜信号 → 按游戏合并
  const byApp = new Map();
  const names = {};
  for (const c of CHARTS) {
    const cur = charts[c.id];
    if (!cur) continue;
    for (const x of cur.ranks) if (x.name) names[x.appid] ||= x.name;
    const signals = chartSignals(cur.ranks, state.charts[c.id] || {}, { key: cur.key });
    for (const [appid, s] of signals) {
      const g = byApp.get(appid) || { appid, hits: [] };
      g.hits.push({ chart: c.id, label: c.label, key: cur.key, ...s, peak: cur.ranks.find((x) => x.appid === appid)?.peak ?? null });
      byApp.set(appid, g);
    }
  }
  // 这次的名次（给每行列出「也在哪些榜上」）
  const ranksNow = new Map();
  for (const c of CHARTS) for (const x of charts[c.id]?.ranks || []) ranksNow.set(x.appid, [...(ranksNow.get(x.appid) || []), { label: c.label, rank: x.rank }]);

  const apps = await appInfo([...byApp.keys()], state);
  const tags = await tagNames(state);
  state.games ||= {};
  const rows = [];
  let outOfWindow = 0;
  for (const g of byApp.values()) {
    const a = apps[g.appid];
    if (a && a.type !== 0) continue; // 0 = 游戏；Steam Deck / 原声 / DLC 不要
    const age = releaseAge(a?.release, today);
    const verdict = judgeCharts(g.hits, age);
    if (!verdict) {
      outOfWindow += 1;
      continue;
    }
    const name = a?.name || names[g.appid] || String(g.appid);
    // 🆕 = 今天第一次报（按日期算：daily.sh 当天失败重跑时，上午那次写过的状态不会把 🆕 吃掉）
    const alertedAt = state.games[g.appid]?.alertedAt;
    rows.push({ ...g, name, release: a?.release, age, verdict, tags: (a?.tagids || []).map((t) => tags[t]).filter(Boolean).slice(0, 3), also: ranksNow.get(g.appid) || [], isNewAlert: !alertedAt || localDate(new Date(alertedAt)) === today });
  }
  rows.sort(compareRows);

  // 加注：新注册域名 / 🧮 工具需求 / 投入价值（全部零额度；失败只在那一格写「失败」）
  const nrd = rows.length ? await nrdCounts(rows.map((r) => r.name)).catch(() => ({ available: false, byName: {}, dates: [] })) : { available: false, byName: {}, dates: [] };
  for (const r of rows.slice(0, TOOL_LIMIT)) {
    try { r.tool = await toolDemand(r.name.replace(/[™®©]/g, '')); } catch { r.tool = { ok: false }; }
  }
  const fromPipeline = await pipelineInvest();
  for (const r of rows.filter((x) => x.verdict === 'go').slice(0, INVEST_LIMIT)) {
    const own = state.games[r.appid]?.invest;
    if (fromPipeline.has(r.appid)) r.invest = fromPipeline.get(r.appid);
    else if (own && Date.now() - Date.parse(own.checkedAt) < 20 * 3600e3) r.invest = own;
    else {
      try {
        const x = await investScore(r.name.replace(/[™®©]/g, ''), r.appid, own || {});
        r.invest = { score: x.score, verdict: x.verdict, dims: x.dims, toolTag: x.toolTag, ccuHistory: x.ccuHistory, checkedAt: x.checkedAt };
      } catch {
        r.invest = null;
      }
    }
  }

  // 状态：各榜快照（日榜留 30 天、周榜留 6 周）+ 报过的游戏
  for (const c of CHARTS) {
    const cur = charts[c.id];
    if (!cur) continue;
    state.charts[c.id][cur.key] = snapshotOf(cur);
    for (const k of Object.keys(state.charts[c.id])) if (daysBetween(k, today) > (c.kind === 'weekly' ? 45 : 30)) delete state.charts[c.id][k];
  }
  for (const r of rows) {
    const g = (state.games[r.appid] ||= { name: r.name, alertedAt: new Date().toISOString() });
    Object.assign(g, { name: r.name, lastVerdict: r.verdict, lastSeen: today });
    if (r.invest && !fromPipeline.has(r.appid)) g.invest = r.invest;
  }
  for (const [id, g] of Object.entries(state.games)) if (daysBetween(g.lastSeen || today, today) > 60) delete state.games[id];
  for (const [id, a] of Object.entries(state.apps || {})) if (Date.now() - Date.parse(a.fetchedAt) > 30 * DAY) delete state.apps[id];

  const meta = { date: today, week, firstRun, charts: Object.fromEntries(Object.entries(charts).map(([k, v]) => [k, v.key])), chartCount: CHARTS.filter((c) => !week || c.kind === 'weekly').length, errors, outOfWindow, seconds: Math.round((Date.now() - started) / 1000), nrd };
  if (!dryRun && !week) {
    state.lastRun = new Date().toISOString();
    await fs.writeFile(statePath, JSON.stringify(state) + '\n');
    await fs.writeFile(path.join(SHIP, `RADAR-STEAMCHARTS-${today}.md`), renderReport(rows, meta));
  }
  return { rows, ...meta };
}

// ─── 报告 ─────────────────────────────────────────────────────────────────────

export const LABEL = { go: '🟢 冲榜', sprout: '🌱 上榜' };
const storeLink = (r) => `[${String(r.name).replace(/[|[\]]/g, ' ')}](https://store.steampowered.com/app/${r.appid}/)`;

export function hitCell(h) {
  const prev = h.signal === 'new' ? `🆕${h.prevRank ? `，上周 #${h.prevRank}` : ''}` : `⬆️ 从 #${h.prevRank}`;
  return `${h.label} #${h.rank}（${prev}）`;
}

function releaseCell(r) {
  if (!r.release?.date) return '?';
  return r.age >= 0 ? `${r.release.date}（发售 ${r.age} 天）` : `${r.release.date}（${-r.age} 天后）`;
}

function investCell(inv) {
  if (inv === undefined) return '-';
  if (!inv) return '失败';
  return `${VERDICT_LABEL[inv.verdict] ?? inv.verdict} ${inv.score}`;
}

export function renderReport(rows, meta) {
  const { date, firstRun, charts, chartCount, errors, outOfWindow, seconds, nrd } = meta;
  const got = Object.keys(charts).length;
  const lines = [
    `# Steam 畅销 / 在玩榜新上榜 ${date}`,
    '',
    '> `game-name-radar/lib/steam-charts-watch.mjs` · 周畅销（全球 / 美 / 德 / 日）+ 在玩榜 + 实时畅销（美 / 德 / 日）前 100，挑「新上榜 / 上升 ≥30 名」且刚发售的 · 零额度',
    '',
    `榜单拿到 ${got}/${chartCount} 个（${Object.entries(charts).map(([id, key]) => `${CHARTS.find((c) => c.id === id)?.label} ${key}`).join(' · ')}）· 有信号但发售超过 ${RULES.maxAgeDays} 天 / 发售日未知的 ${outOfWindow} 个已滤掉 · 耗时 ${seconds} 秒`,
    '',
    `判决：🟢 冲榜 = 有一个榜进前 ${RULES.goRank}，且发售 ≤${RULES.goAgeDays} 天或 ${RULES.maxUpcomingDays} 天内发售 · 🌱 上榜 = 其余（名次 51–100 或发售 31–${RULES.maxAgeDays} 天）。`,
    `信号：🆕 = 前 ${RULES.newLookbackDays} 天（周榜 = 前两周）都不在前 100 · ⬆️ = 比上次名次升 ≥${RULES.jump}。周畅销滞后约一周（统计周从周二开始），实时畅销补这一周。`,
    '',
  ];
  if (firstRun) lines.push('> ⚠️ 首次运行：实时畅销只建基线（明天起才有对比）；周畅销已回补前两周、在玩榜用榜单自带的上周名次，今天就有信号。', '');
  if (errors.length) lines.push(`> 榜单失败：${errors.join('；')}`, '');
  if (rows.length) {
    lines.push('| 判决 | 游戏 | 上榜信号 | 发售 | 标签 | 工具需求 | 投入价值 | 新注册域名 | 也在 |', '|---|---|---|---|---|---|---|---|---|');
    for (const r of rows.slice(0, 40)) {
      const domains = nrd.available ? nrdNote(nrd.byName[r.name], { days: nrd.dates.length }) || '-' : '-';
      const hitLabels = new Set(r.hits.map((h) => h.label));
      const also = r.also.filter((x) => !hitLabels.has(x.label)).map((x) => `${x.label} #${x.rank}`).slice(0, 3).join('，') || '-';
      lines.push(`| ${LABEL[r.verdict]}${r.isNewAlert ? ' 🆕' : ''} | ${storeLink(r)} | ${r.hits.map(hitCell).join('<br>')} | ${releaseCell(r)} | ${r.tags.join(' / ') || '-'} | ${r.tool ? toolDemandNote(r.tool, { examples: 1 }) : '-'} | ${investCell(r.invest)} | ${domains} | ${also} |`);
    }
    lines.push('');
  } else {
    lines.push('今天没有刚发售、又新冲上榜的游戏。', '');
  }
  lines.push('下一步（🟢）：①`node radar.mjs check "<游戏名>"` 看工具闸门 + 投入价值细项 ②「新注册域名」⚠️ = 同行在抢，要么当天买要么放弃 ③口碑型（发售后才冲上来）的窗口按周算，别等第二周');
  return lines.join('\n') + '\n';
}

const IS_MAIN = import.meta.url === `file://${process.argv[1]}` || Boolean(process.argv[1]?.endsWith('steam-charts-watch.mjs'));
if (IS_MAIN) {
  const args = process.argv.slice(2);
  const week = args.find((a) => a.startsWith('--week='))?.split('=')[1] || null;
  const r = await runSteamChartsWatch({ dryRun: args.includes('--dry-run'), week });
  const count = (v) => r.rows.filter((x) => x.verdict === v).length;
  console.log(`Steam 畅销 / 在玩榜${week ? `（回测 ${week} 那周，按 ${r.date} 判）` : ''}：榜单 ${Object.keys(r.charts).length}/${r.chartCount} · 🟢 ${count('go')} · 🌱 ${count('sprout')} · 窗口外滤掉 ${r.outOfWindow} · ${r.seconds}s${r.errors.length ? `；失败 ${r.errors.join('；')}` : ''}`);
  for (const x of r.rows.slice(0, week || args.includes('--dry-run') ? 40 : 10)) {
    console.log(`  ${LABEL[x.verdict]} ${x.name}（${x.release?.date ?? '?'}，${x.age >= 0 ? `发售 ${x.age} 天` : `${-x.age} 天后`}）：${x.hits.map(hitCell).join('；')}${x.tool ? ` · ${toolDemandNote(x.tool, { examples: 1 })}` : ''}${x.invest ? ` · 投入价值 ${investCell(x.invest)}` : ''}`);
  }
  if (week || args.includes('--dry-run')) console.log('（试跑 / 回测：不写状态和报告）');
}
