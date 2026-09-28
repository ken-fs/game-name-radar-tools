#!/usr/bin/env node
/**
 * roblox-yt-mismatch.mjs —「Hole Fishing 模型」错配扫描：找创作者跑得比玩家快的游戏
 *
 * 背景（2026-09-28 沉淀）：Hole Fishing 发现时只有 3,109 CCU——不在任何榜单头部，
 * 是人工翻发现页看到的；但创作者视频 12 天 150K 播放、SERP 零竞争 → 教科书级套利窗口。
 * growth-scan 按 growth×log10(CCU) 排序，这种腰部游戏会被埋掉；
 * youtube-buzz 又只对 top 3-5 候选人工跑。本脚本把「YouTube 热度 ÷ CCU」错配
 * 作为第一信号，对腰部池（800-15K CCU）全量自动扫。
 *
 * 信号定义：
 *   ratio = 本周视频播放中位数 ÷ CCU
 *   🎣🎣 强错配：本周独立频道 ≥5 且 ratio ≥ 2   ← Hole Fishing 级
 *   🎣  错配：  本周独立频道 ≥3 且 ratio ≥ 1
 *   判读仍走完整流程（Step 1.5 需求 → Step 2 SERP → Step 3 竞品），本脚本只做发现。
 *
 * 用法：
 *   NODE_USE_ENV_PROXY=1 https_proxy=http://127.0.0.1:7897 node lib/roblox-yt-mismatch.mjs
 *   --min-ccu=800 --max-ccu=15000 --limit=40 --fresh（忽略 7 天缓存）
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CACHE = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "yt-mismatch-cache.json");
const SORTS = ["up-and-coming", "top-trending", "top-playing-now", "fun-with-friends", "top-rated"];
// 2026-09-28：sorts 按 IP 地理个性化且每榜只 ~30 条、无分页——单国视图会丢游戏。
// 多国扫描合并池子（Roblox 大市场全扫）；非 US 首发 = 更早期的套利窗口，单独标记。
const COUNTRIES = ["us", "br", "ph", "mx", "id", "th", "gb", "de", "fr", "jp", "kr"];
const WEEK = "EgQIAxAB"; // YouTube sp 筛选：本周
const CACHE_TTL = 7 * 864e5;

const arg = (k, d) => Number((process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").split("=")[1]) || d;
const MIN_CCU = arg("min-ccu", 800);
const MAX_CCU = arg("max-ccu", 15000);
const LIMIT = arg("limit", 40);
const FRESH = process.argv.includes("--fresh");

// 与 growth-scan 同源；GOOD 补 fish（Hole Fishing 的名字/描述命中不了原词表，会被误杀）
const GOOD = /(codes?|unit|pet|egg|loot|evolve|hatch|forge|anime|simulator|clicker|incremental|tier|class|weapon|sword|aura|fruit|dungeon|quest|grind|rarity|rarities|fish)/i;
const BAD = /(obby|roleplay|\bRP\b|hangout|shooter|\bgun\b|horror|escape|survive the|tycoon)/i;

const now = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    if (res.status === 429) { await sleep(8000 * (i + 1) * (i + 1)); continue; } // 限频退避（games API 限时严：8/32/72s）
    throw new Error(`HTTP ${res.status} ${url.slice(0, 80)}`);
  }
  throw new Error(`HTTP 429 ${url.slice(0, 80)}`);
}

let cache = {};
try { cache = JSON.parse(readFileSync(CACHE, "utf8")); } catch {}

function ytWeek(game) {
  const q = encodeURIComponent(`${game} roblox`);
  try {
    const out = execFileSync(
      "yt-dlp",
      [`https://www.youtube.com/results?search_query=${q}&sp=${WEEK}`, "--flat-playlist", "--dump-json", "--no-warnings", "--playlist-end", "10"],
      { encoding: "utf8", timeout: 90_000, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 20 * 1024 * 1024 },
    );
    const rows = out.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const channels = new Set(rows.map((r) => r.channel).filter(Boolean));
    const views = rows.map((r) => r.view_count ?? 0).filter((v) => v > 0).sort((a, b) => a - b);
    return { videos: rows.length, channels: channels.size, medianViews: views.length ? views[Math.floor(views.length / 2)] : 0 };
  } catch {
    return null; // 失败 = 未测（不缓存、不编造）
  }
}

// 1. 榜单池（多国 × 5 榜，合并去重，记录来源国）
const geo = new Map(); // uid -> Set(country)
for (const c of COUNTRIES) {
  for (const sort of SORTS) {
    try {
      const d = await fetchJson(`https://apis.roblox.com/explore-api/v1/get-sort-content?sortId=${sort}&sessionId=scan&device=computer&country=${c}`);
      for (const g of d.games ?? []) {
        if (!g.universeId) continue;
        if (!geo.has(g.universeId)) geo.set(g.universeId, new Set());
        geo.get(g.universeId).add(c);
      }
    } catch { /* 单榜失败不阻断 */ }
  }
  await sleep(200);
}
const ids = new Set(geo.keys());
const usCount = [...geo.values()].filter((s) => s.has("us")).length; // filter 返回数组，用 length
console.log(`榜单池 ${ids.size} 个游戏（${COUNTRIES.length} 国 × ${SORTS.length} 榜；US 上榜 ${usCount}，非 US ${ids.size - usCount}），拉详情…`);

// 2. 批量详情
const list = [...ids];
const details = [];
for (let i = 0; i < list.length; i += 50) {
  const d = await fetchJson(`https://games.roblox.com/v1/games?universeIds=${list.slice(i, i + 50).join(",")}`);
  details.push(...(d.data ?? []));
  await sleep(800);
}

// 3. 腰部过滤：CCU 带宽 + 14 天内更新（EVENT 窗口）+ 1 年内建游
const pool = details
  .filter((g) => g.playing >= MIN_CCU && g.playing <= MAX_CCU)
  .filter((g) => now - new Date(g.updated).getTime() <= 14 * 864e5)
  .filter((g) => now - new Date(g.created).getTime() <= 365 * 864e5)
  .filter((g) => GOOD.test(`${g.name} ${g.description ?? ""}`) && !BAD.test(`${g.name} ${g.description ?? ""}`))
  .sort((a, b) => a.playing - b.playing) // 小的在前：越小的越可能没被发现
  .slice(0, LIMIT);

console.log(`腰部池 ${pool.length} 个（${MIN_CCU}-${MAX_CCU} CCU），逐查 YouTube 本周信号…\n`);

// 4. 逐查 YouTube（缓存 7 天）
const rows = [];
let scanned = 0, cached = 0;
for (const g of pool) {
  const id = String(g.id);
  let yt = !FRESH && cache[id] && now - cache[id].ts < CACHE_TTL ? (cached++, cache[id]) : null;
  if (!yt) {
    yt = ytWeek(g.name);
    scanned++;
    if (yt) { cache[id] = { ...yt, ts: now }; await sleep(1500); }
  }
  if (!yt) continue; // 未测
  const ratio = yt.medianViews / Math.max(1, g.playing);
  const flag = yt.channels >= 5 && ratio >= 2 ? "🎣🎣" : yt.channels >= 3 && ratio >= 1 ? "🎣" : "";
  const countries = geo.get(String(g.id)) ?? geo.get(g.id) ?? new Set();
  const geoTag = !countries.has("us") ? `非US首发[${[...countries].join(",").slice(0, 12)}]` : "";
  rows.push({ id: g.id, name: g.name, playing: g.playing, visits: g.visits, yt, ratio, flag, geoTag });
}
writeFileSync(CACHE, JSON.stringify(cache));

// 5. 输出（错配在前，按 ratio 排）
const hits = rows.filter((r) => r.flag).sort((a, b) => b.ratio - a.ratio);
console.log(`═══ 错配命中（${hits.length}/${rows.length} 已测，yt 新扫 ${scanned} / 缓存 ${cached}）═══\n`);
console.log("  ratio   本周频道  中位播放   CCU     游戏");
for (const r of hits) {
  console.log(
    `  ${r.flag} ${r.ratio.toFixed(1).padStart(5)}  ${String(r.yt.channels).padStart(6)}  ${String(r.yt.medianViews.toLocaleString()).padStart(8)}  ${String(r.playing).padStart(6)}  ${r.name.slice(0, 44)}  [${r.id}]${r.geoTag ? "  " + r.geoTag : ""}`,
  );
}
if (!hits.length) console.log("  （无命中——正常，错配是低频事件；腰部池快照见下行）");
console.log("\n附：腰部池 CCU 最小的 5 个（供人工抽查 yt 未测/冷门项）：");
for (const r of rows.sort((a, b) => a.playing - b.playing).slice(0, 5)) {
  console.log(`  ${String(r.playing).padStart(6)} CCU  ratio ${r.ratio.toFixed(2).padStart(5)}  ${r.name.slice(0, 44)}`);
}
