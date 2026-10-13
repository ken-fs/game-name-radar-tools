#!/usr/bin/env node
/**
 * tool-demand.mjs — 交易 / 数值 / 计算器需求（2026-10-13 加）
 *
 * 为什么需要：Ship/research/GAME-WIKI-STRUCTURE-2026-10.md 实测，流量最大的独立游戏站全是
 * 「首页就是工具」的价值表 / 计算器站（elvebredd ≈107 万/月、bloxfruitsvalues ≈27 万），
 * 而且这类词大媒体只在 4/10 的结果页进前 5。以前雷达只把 value list 混在攻略词里，看不出来。
 *
 * 做法：Google Suggest（免费）查「<游戏> value / values / calculator / trading / stock」5 个种子，
 * 只数**含游戏名**且带工具意图（value list / values / calculator / trade / worth / stock / checker…）的补全。
 * ≥2 条 = 🧮 工具需求。含游戏名这条很关键：Pets Universe 查 value 会被 Google 纠成
 * 「pet universe price list」（卡塔尔一家宠物店），不能算。
 *
 * 结果缓存 24 小时（data/tool-demand-cache.json）：Roblox 需求验证、投入价值、总报告会查同一批名字，不重复打 Google。
 *
 * 用法：node lib/tool-demand.mjs "Grow a Garden" "Pets Universe"
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchSuggestionsStrict } from './roblox-demand-scan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = join(HERE, '..', 'data', 'tool-demand-cache.json');
const TTL = 24 * 3600_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const TOOL_SEEDS = ['value', 'values', 'calculator', 'trading', 'stock'];
// 工具意图：价值表 / 计算器 / 交易 / 库存（GAG 的 stock notifier / predictor 也是工具站在接）
const TOOL_INTENT = /\b(value ?list|values?|calculator|calc|trad(?:e|es|ing)|worth|stock|price ?list|checker|predictor|notifier|tracker)\b/i;
// 不是游戏内工具：Steam 集换卡、「值不值得买」、实体版现货 / 缺货（2026-10-13 补 out of stock：steelbook / 手柄缺货）、公司股价
const NOT_TOOL = /\b(trading cards?|worth it|worth buying|in stock|out of stock|restock|stock price|share price|preorder)\b/i;

export const normName = (s) => String(s).toLowerCase().replace(/[™®©]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** 纯函数：补全 → 带工具意图、含游戏名的补全（去重） */
export function classifyToolDemand(game, suggestions) {
  const name = normName(game);
  if (!name) return [];
  const hits = new Set();
  for (const raw of suggestions) {
    const q = normName(raw);
    if (!` ${q} `.includes(` ${name} `)) continue;
    // 先剥掉游戏名再判意图（游戏名本身带 value / trade 的不算）
    const rest = ` ${q} `.replace(` ${name} `, ' ');
    if (TOOL_INTENT.test(rest) && !NOT_TOOL.test(rest)) hits.add(q);
  }
  return [...hits];
}

function readCache() {
  try { return existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, 'utf8')) : {}; } catch { return {}; }
}

/**
 * 查一个游戏。返回 { game, ok, count, hits, tag, failed, checkedAt }；
 * 5 个种子全失败 = ok:false（报告里写「查询失败」，不当成 0）。永不抛。
 */
export async function toolDemand(game, { fetcher = fetchSuggestionsStrict, cache = true } = {}) {
  const key = normName(game);
  const query = String(game).toLowerCase().replace(/[™®©]/g, '').trim();
  const store = cache ? readCache() : {};
  const hit = store[key];
  if (hit && Date.now() - Date.parse(hit.checkedAt) < TTL) return { ...hit, cached: true };

  const all = [];
  let failed = 0;
  for (const seed of TOOL_SEEDS) {
    try { all.push(...(await fetcher(`${query} ${seed}`))); } catch { failed += 1; }
    await sleep(300);
  }
  const hits = classifyToolDemand(game, all);
  const r = { game, ok: failed < TOOL_SEEDS.length, count: hits.length, hits: hits.slice(0, 12), tag: hits.length >= 2, failed, checkedAt: new Date().toISOString() };
  if (cache && r.ok) {
    const fresh = readCache(); // 重读：并行子进程可能刚写过
    fresh[key] = r;
    for (const [k, v] of Object.entries(fresh)) if (Date.now() - Date.parse(v.checkedAt) > 7 * TTL) delete fresh[k];
    try { writeFileSync(CACHE_FILE, JSON.stringify(fresh, null, 2) + '\n'); } catch { /* 缓存写不进不影响结果 */ }
  }
  return r;
}

/** 报告里的一小段：「🧮 工具需求 12 条（grow a garden values / …）」 */
export function toolDemandNote(r, { examples = 2 } = {}) {
  if (!r) return '';
  if (!r.ok) return '工具需求 查询失败';
  if (!r.count) return '工具需求 0';
  const eg = r.hits.slice(0, examples).join(' / ');
  return `${r.tag ? '🧮 ' : ''}工具需求 ${r.count} 条（${eg}）`;
}

const IS_MAIN = Boolean(process.argv[1]?.endsWith('tool-demand.mjs'));
if (IS_MAIN) {
  const games = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!games.length) {
    console.error('用法: node lib/tool-demand.mjs "游戏名" ["游戏名2" ...]');
    process.exit(1);
  }
  for (const g of games) {
    const r = await toolDemand(g, { cache: !process.argv.includes('--no-cache') });
    console.log(`${g}: ${toolDemandNote(r, { examples: 5 })}${r.failed ? ` · ${r.failed}/${TOOL_SEEDS.length} 个种子请求失败` : ''}${r.cached ? '（缓存）' : ''}`);
  }
}
