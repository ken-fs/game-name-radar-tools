#!/usr/bin/env node
/**
 * suggest-diff-watch.mjs — Google 联想词每日差分（2026-10-12 加）
 *
 * 为什么需要：玩家搜「codes for <游戏>」「tier list for <游戏>」「best class in <游戏>」的时候，
 * Google 联想会把**最近搜得多的游戏名**补出来。一个游戏名**第一次**出现在这些补全里 = 刚有一批人开始搜它的攻略，
 * 通常比 Trends 曲线、比聚合站文章都早。现有的联想用法不一样：
 *   - playable-trend-watch 用「poki games / crazy games / unblocked」+ a-z 只是**发现可玩游戏名**，不做日差分
 *   - meme-game-watch 是给已知梗名查「<梗> game」
 * 这里做的是**差分**：每天把一批「攻略意图」前缀 + a-z 的全部补全记下来，和过去 14 天出现过的比，新冒出来的才算。
 *
 * 种子（前缀后面直接跟游戏名，补全里切掉前缀就是游戏名）：
 *   攻略类（算「游戏意图」）：codes for · tier list for · best class in · best build for · value list for ·
 *                             how to beat · roblox anime
 *   混合类（剧集 / 电影 / 手机也会出现，单独出现不算）：wiki for · release date for ·
 *                             how to fix（2026-10-16 加：报错修复意图。万物皆可 fix，单独出现不算游戏意图，
 *                             只当佐证——和 codes / tier list 等同天出现 = 玩家真卡住了）
 *   每个前缀 + a–z；「codes for」再加「字母 + 元音」两位（码站是 Roblox 攻略站的主力意图，单字母只给 10 条太挤）
 *   → 每天约 370 次请求，间隔 250ms，约 3–4 分钟。
 *
 * 判决（第一天只建基线）：
 *   🟢 新游戏词  过去 14 天没见过的名字，3 天内冒出来，且今天出现在 ≥2 类攻略意图里（codes + tier list …），
 *                或连续 ≥2 天出现在攻略意图里 —— 一个意图偶尔冒一下可能是联想抖动，两类 / 两天同时有 = 真有人在搜
 *   🆕 新冒出    今天第一次出现在某个攻略意图里（只列在报告里，不进总报告）
 *   ⚪ 非游戏    只出现在 wiki for / release date for（剧集、电影、手机居多）
 *
 * 🟢 会查「最近 3 天新注册域名」（lib/nrd.mjs）。
 *
 * 用法：
 *   node lib/suggest-diff-watch.mjs                     # 跑一轮，写 ../RADAR-SUGGEST-<日期>.md
 *   node lib/suggest-diff-watch.mjs --dry-run --seeds=3 # 小规模试跑：每类只跑前 3 个字母，不写状态 / 报告
 *   不推通知：🟢 进 radar.mjs 的「今天最值得看」，由总报告统一推。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nrdCounts, nrdNote } from './nrd.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIP = path.join(root, '..');
const statePath = path.join(root, 'data', 'suggest-diff-state.json');
const LOOKBACK_DAYS = 14;
const KEEP_DAYS = 30;
const FRESH_DAYS = 3;
const GAP_MS = 250;
const DAY = 864e5;
const localDate = (d = new Date()) => d.toLocaleDateString('sv-SE');
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');
const VOWELS = ['a', 'e', 'i', 'o', 'u'];
export const FAMILIES = [
  { id: 'codes', prefix: 'codes for ', game: true, label: 'codes', twoLetter: true },
  { id: 'tier', prefix: 'tier list for ', game: true, label: 'tier list' },
  { id: 'class', prefix: 'best class in ', game: true, label: 'best class' },
  { id: 'build', prefix: 'best build for ', game: true, label: 'best build' },
  { id: 'value', prefix: 'value list for ', game: true, label: 'value list' },
  { id: 'beat', prefix: 'how to beat ', game: true, label: 'how to beat' },
  { id: 'fix', prefix: 'how to fix ', game: false, label: 'how to fix' },
  { id: 'robloxanime', prefix: 'roblox ', seedPrefix: 'roblox anime ', game: true, label: 'roblox anime' },
  { id: 'wiki', prefix: 'wiki for ', game: false, label: 'wiki' },
  { id: 'release', prefix: 'release date for ', game: false, label: 'release date' },
];

/** 每个前缀 + a–z（codes 再加两位），总请求数可控 */
export function buildSeeds(families = FAMILIES, letterLimit = LETTERS.length) {
  const out = [];
  for (const f of families) {
    const base = f.seedPrefix || f.prefix;
    const letters = LETTERS.slice(0, letterLimit);
    for (const ch of letters) out.push({ family: f.id, query: base + ch });
    if (f.twoLetter) for (const ch of letters) for (const v of VOWELS) out.push({ family: f.id, query: base + ch + v });
  }
  return out;
}

// 补全尾巴上的修饰词：去掉后才是游戏名（codes for huss valley roblox → huss valley）
const TAIL = /\s+(roblox|codes?|wiki|fandom|trello|discord|tier list|tierlist|value list|values?|list|guide|update|new|today|not working|working|active|not expired|redeem|pc|ps5|ps4|xbox|switch|mobile|steam|game|games|\d{4}|october|november|december|september|reddit|crashing|crash|lag|lagging|errors?|broken|glitches?|bugs?|stuck|freezing|freeze|fps|ping|not loading|black screen|issues?)$/i;
const NOT_GAME = /^(robux|free robux|items|kids|beginners|dummies|all|everything|the|a|an|me|you|my|your|it|this|that|bg3 ?|life|anxiety|depression|procrastination|stress|insomnia)$/i;

/** 补全 → 游戏名（前缀不对 / 剩下太短 / 明显不是游戏 → ''） */
export function extractName(suggestion, family) {
  const s = String(suggestion).toLowerCase().replace(/\s+/g, ' ').trim();
  if (!s.startsWith(family.prefix)) return '';
  let name = s.slice(family.prefix.length).trim();
  for (let i = 0; i < 4 && TAIL.test(name); i += 1) name = name.replace(TAIL, '').trim();
  if (name.length < 3 || name.length > 40 || name.split(' ').length > 6) return '';
  if (NOT_GAME.test(name) || !/[a-z]/.test(name)) return '';
  return name;
}

/**
 * 差分（纯函数）：今天的 { query → suggestions[] } + 旧状态 → 新状态 + 今天的名字表。
 * state = { lastRun, suggestions: { text: { first, last, family } }, names: { name: { first, last, gameDays: [], families: { id: lastDate }, base } } }
 */
export function diffDay(state, results, today, families = FAMILIES) {
  const byId = Object.fromEntries(families.map((f) => [f.id, f]));
  const next = { suggestions: { ...(state.suggestions || {}) }, names: JSON.parse(JSON.stringify(state.names || {})) };
  const baseline = !state.lastRun;
  const newSuggestions = [];
  const todayNames = new Map(); // name → { families:Set, examples:[] }
  for (const { family, query, suggestions } of results) {
    const f = byId[family];
    for (const raw of suggestions) {
      const text = String(raw).toLowerCase().trim();
      const prev = next.suggestions[text];
      const isNew = !prev || daysBetween(prev.last, today) > LOOKBACK_DAYS;
      next.suggestions[text] = { first: isNew ? today : prev.first, last: today, family };
      if (isNew && !baseline) newSuggestions.push({ text, family, query });
      const name = extractName(text, f);
      if (!name) continue;
      const t = todayNames.get(name) || { families: new Set(), examples: [] };
      t.families.add(family);
      if (t.examples.length < 3 && !t.examples.includes(text)) t.examples.push(text);
      todayNames.set(name, t);
    }
  }
  const rows = [];
  for (const [name, t] of todayNames) {
    const prev = next.names[name];
    const fresh = !prev || daysBetween(prev.last, today) > LOOKBACK_DAYS;
    // base = 建基线那天就有的名字，永远不算「新」
    const e = fresh ? { first: today, last: today, gameDays: [], families: {}, base: baseline } : prev;
    const gameToday = [...t.families].filter((f) => byId[f]?.game);
    e.last = today;
    if (gameToday.length && !e.gameDays.includes(today)) e.gameDays = [...e.gameDays, today].slice(-14);
    for (const f of t.families) e.families[f] = today;
    next.names[name] = e;
    const age = daysBetween(e.first, today);
    let verdict = 'old';
    if (!baseline && !e.base && age <= FRESH_DAYS) {
      if (gameToday.length >= 2 || (gameToday.length >= 1 && e.gameDays.length >= 2)) verdict = 'go';
      else if (gameToday.length >= 1) verdict = 'new';
      else if (!e.gameDays.length) verdict = 'nongame';
    }
    rows.push({ name, verdict, families: [...t.families], gameFamilies: gameToday, examples: t.examples, first: e.first, days: e.gameDays.length });
  }
  // 清理：30 天没再出现的补全 / 名字
  for (const [k, v] of Object.entries(next.suggestions)) if (daysBetween(v.last, today) > KEEP_DAYS) delete next.suggestions[k];
  for (const [k, v] of Object.entries(next.names)) if (daysBetween(v.last, today) > KEEP_DAYS) delete next.names[k];
  return { state: next, rows, newSuggestions, baseline };
}

async function autocomplete(query) {
  for (let i = 0; i < 2; i += 1) {
    try {
      const res = await fetch(`https://suggestqueries.google.com/complete/search?client=firefox&hl=en&gl=us&q=${encodeURIComponent(query)}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = JSON.parse(new TextDecoder().decode(await res.arrayBuffer()));
      return { ok: true, list: Array.isArray(d?.[1]) ? d[1] : [] };
    } catch {
      await sleep(1500);
    }
  }
  return { ok: false, list: [] };
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function runSuggestDiff({ dryRun = false, letterLimit = LETTERS.length } = {}) {
  const started = Date.now();
  const today = localDate();
  const state = await readJson(statePath, {});
  const seeds = buildSeeds(FAMILIES, letterLimit);
  const results = [];
  let failed = 0;
  for (const s of seeds) {
    const r = await autocomplete(s.query);
    if (!r.ok) failed += 1;
    results.push({ ...s, suggestions: r.list });
    await sleep(GAP_MS);
  }
  // 一半以上失败 = 网络 / 限流问题，不写状态（否则明天全是「新词」）
  const broken = failed > seeds.length / 2;
  const { state: next, rows, newSuggestions, baseline } = diffDay(state, results.filter((r) => r.suggestions.length), today);
  const go = rows.filter((r) => r.verdict === 'go');
  const nrd = go.length ? await nrdCounts(go.map((r) => r.name)) : { available: false, byName: {}, dates: [] };
  const meta = { date: today, baseline, requests: seeds.length, failed, broken, seconds: Math.round((Date.now() - started) / 1000), totalSuggestions: results.reduce((n, r) => n + r.suggestions.length, 0), newSuggestions: newSuggestions.length, nrd };
  if (!dryRun && !broken) {
    next.lastRun = new Date().toISOString();
    await fs.writeFile(statePath, JSON.stringify(next) + '\n');
    await fs.writeFile(path.join(SHIP, `RADAR-SUGGEST-${today}.md`), renderReport(rows, meta));
  }
  return { rows, ...meta };
}

const LABEL = { go: '🟢 新游戏词', new: '🆕 新冒出', nongame: '⚪ 非游戏' };
const famLabel = (ids) => ids.map((id) => FAMILIES.find((f) => f.id === id)?.label || id).join(' + ');

export function renderReport(rows, meta) {
  const { date, baseline, requests, failed, seconds, totalSuggestions, newSuggestions, nrd } = meta;
  const lines = [
    `# Google 联想词差分 ${date}`,
    '',
    '> `game-name-radar/lib/suggest-diff-watch.mjs` · 「codes for / tier list for / best class in / best build for / value list for / how to beat / how to fix / roblox anime / wiki for / release date for」+ a–z 的全部补全，和过去 14 天比 · 零额度',
    '',
    `请求 ${requests} 次（失败 ${failed}）· 补全 ${totalSuggestions} 条 · 新冒出的补全 ${newSuggestions} 条 · 耗时 ${Math.round(seconds / 60)} 分钟`,
    '',
    `🟢 新游戏词 = 过去 14 天没见过、${FRESH_DAYS} 天内冒出来，且今天出现在 ≥2 类攻略意图里（或连续 ≥2 天出现）。只出现一类一天的列在 🆕，可能是联想抖动。`,
    '',
  ];
  if (baseline) lines.push('> ⚠️ 首次运行 = 建基线：今天看到的补全全部记为「已知」，明天起才有差分。', '');
  const go = rows.filter((r) => r.verdict === 'go').sort((a, b) => b.gameFamilies.length - a.gameFamilies.length || b.days - a.days);
  const fresh = rows.filter((r) => r.verdict === 'new');
  const nongame = rows.filter((r) => r.verdict === 'nongame');
  if (go.length) {
    lines.push('| 判决 | 游戏名 | 攻略意图 | 补全例子 | 首见 | 新注册域名 |', '|---|---|---|---|---|---|');
    for (const r of go) lines.push(`| ${LABEL.go} | ${r.name} | ${famLabel(r.gameFamilies)}（${r.days} 天） | ${r.examples.join(' · ')} | ${r.first} | ${nrd.available ? nrdNote(nrd.byName[r.name], { days: nrd.dates.length }) : '-'} |`);
    lines.push('');
  } else if (!baseline) {
    lines.push('今天没有达到 🟢 的新游戏词。', '');
  }
  if (fresh.length) {
    lines.push(`<details><summary>🆕 新冒出 ${fresh.length} 个（只在一类意图里出现，明天再出现或多一类就升 🟢）</summary>`, '');
    lines.push(fresh.map((r) => `${r.name}（${famLabel(r.gameFamilies)}）`).join(' · '), '', '</details>', '');
  }
  if (nongame.length) {
    lines.push(`<details><summary>⚪ 非游戏类新词 ${nongame.length} 个（只在 wiki for / release date for / how to fix）</summary>`, '', nongame.map((r) => r.name).join(' · '), '', '</details>', '');
  }
  lines.push('下一步（🟢）：`node radar.mjs check "<游戏名>"` 判平台（Roblox 需求验证 / Steam 工具闸门）→ 看「新注册域名」有没有同行在抢。');
  return lines.join('\n') + '\n';
}

const IS_MAIN = import.meta.url === `file://${process.argv[1]}` || Boolean(process.argv[1]?.endsWith('suggest-diff-watch.mjs'));
if (IS_MAIN) {
  const args = process.argv.slice(2);
  const seedArg = args.find((a) => a.startsWith('--seeds='));
  const r = await runSuggestDiff({ dryRun: args.includes('--dry-run'), letterLimit: seedArg ? Number(seedArg.split('=')[1]) : LETTERS.length });
  const count = (v) => r.rows.filter((x) => x.verdict === v).length;
  console.log(`联想词差分：请求 ${r.requests}（失败 ${r.failed}）· 补全 ${r.totalSuggestions} · 新补全 ${r.newSuggestions} · 名字 ${r.rows.length} · 🟢 ${count('go')} · 🆕 ${count('new')} · ${r.seconds}s${r.baseline ? '（首次建基线）' : ''}${r.broken ? ' ⚠️ 一半以上请求失败，没写状态' : ''}${args.includes('--dry-run') ? '（试跑，不写状态 / 报告）' : ''}`);
  for (const x of r.rows.filter((x) => x.verdict === 'go').slice(0, 10)) console.log(`  🟢 ${x.name}：${famLabel(x.gameFamilies)} · ${x.examples[0]}`);
  if (args.includes('--dry-run')) console.log(`  名字样例：${r.rows.slice(0, 25).map((x) => x.name).join(' · ')}`);
}
