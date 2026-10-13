#!/usr/bin/env node
/**
 * roblox-growth-scan.mjs — Roblox 成长期游戏扫描（Dungeon Lootr 模型）
 *
 * 目标：找出「像 Dungeon Lootr 一样」的游戏——
 *   1. 成长期：当前速率 ≫ 生命周期均值（增长比 = CCU×60 ÷ 日均访问）
 *      （CCU×60 ≈ 日访问，用 Dungeon Lootr 实测校准：6.5K CCU ≈ 39 万访问/天）
 *   2. 活服务：近 7 天有更新
 *   3. 数据型需求潜力：收集/养成/RPG 类（units/pets/eggs/loot/codes），非 obby/RP/射击
 *   4. 规模甜区：CCU 300-60K（2026-09-25 从 800 下调——榜单头部池已扫透，
 *      小游戏池更大、竞品更少。用 --min-ccu=800 可恢复旧阈值）
 *      大游戏 SERP 被 Fandom/大媒体锁死，太小没需求
 *
 * 用法：NODE_USE_ENV_PROXY=1 https_proxy=http://127.0.0.1:7897 node roblox-growth-scan.mjs
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getOwnGames, cleanGameName } from "./own-games.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SORTS = ["up-and-coming", "top-trending", "top-playing-now", "fun-with-friends", "top-rated"];
// 多国扫描（2026-09-28）：sorts 按 IP 地理个性化且每榜 ~30 条无分页，单国会丢游戏
const COUNTRIES = ["us", "br", "ph", "mx", "id", "th", "gb", "de", "fr", "jp", "kr"];
const MIN_CCU = Number((process.argv.find((a) => a.startsWith("--min-ccu=")) ?? "").split("=")[1]) || 300;

// 数据型需求加分词 / 排除词
const GOOD = /(codes?|unit|pet|egg|loot|evolve|hatch|forge|anime|simulator|clicker|incremental|tier|class|weapon|sword|aura|fruit|dungeon|quest|grind|rarity|rarities)/i;
const BAD = /(obby|roleplay|\bRP\b|hangout|shooter|\bgun\b|horror|escape|survive the|tycoon)/i;

const now = Date.now();

async function fetchJson(url) {
  // 429 限流 / 瞬时错误：退避重试 4 次（11 国榜单后紧接着批量拉详情，容易撞限流）
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url).catch((e) => ({ ok: false, status: e.code ?? "ERR" }));
    if (res.ok) return res.json();
    if (attempt >= 4 || (res.status !== 429 && res.status < 500 && res.status !== "ERR")) {
      throw new Error(`HTTP ${res.status} ${url.slice(0, 80)}`);
    }
    await new Promise((r) => setTimeout(r, 5000 * 2 ** attempt));
  }
}

// 1. 收集榜单里的 universeId（多国 × 5 榜合并）
const ids = new Set();
for (const c of COUNTRIES) {
  for (const sort of SORTS) {
    try {
      const d = await fetchJson(`https://apis.roblox.com/explore-api/v1/get-sort-content?sortId=${sort}&sessionId=scan&device=computer&country=${c}`);
      for (const g of d.games ?? []) if (g.universeId) ids.add(g.universeId);
    } catch { /* 单榜失败不阻断 */ }
  }
  await new Promise((r) => setTimeout(r, 200));
}
console.log(`榜单候选: ${ids.size} 个游戏（${COUNTRIES.length} 国 × ${SORTS.length} 榜），拉详情…`);

// 2. 批量拉详情（每批 50）
const list = [...ids];
const details = [];
for (let i = 0; i < list.length; i += 50) {
  const batch = list.slice(i, i + 50).join(",");
  const d = await fetchJson(`https://games.roblox.com/v1/games?universeIds=${batch}`);
  details.push(...(d.data ?? []));
  await new Promise((r) => setTimeout(r, 400));
}

// 3. 计算与筛选
// 自家站排除（2026-10-13）：Anime Mysterious 建站上线后雷达又报 GO 的教训——
// 雷达是找「别人家起量的游戏」，自家游戏命中是纯噪音，还会误导 occupy-queue 推销已覆盖的域名
const own = await getOwnGames();
const ownHits = details.filter((g) => own.universeIds.has(String(g.id)) || own.names.has(cleanGameName(g.name)));
if (ownHits.length) console.log(`自家站排除: ${ownHits.map((g) => cleanGameName(g.name)).join(" / ")}`);
const ownSet = new Set(ownHits.map((g) => String(g.id)));
const rows = [];
for (const g of details) {
  if (ownSet.has(String(g.id))) continue;
  const created = new Date(g.created).getTime();
  const updated = new Date(g.updated).getTime();
  const ageDays = Math.max(1, (now - created) / 864e5);
  const freshDays = (now - updated) / 864e5;
  const lifetimeAvg = g.visits / ageDays;
  const currentRate = g.playing * 60;
  const growth = currentRate / Math.max(1, lifetimeAvg);
  const text = `${g.name} ${g.description ?? ""}`;
  const good = GOOD.test(text);
  const bad = BAD.test(text);
  rows.push({ id: g.id, name: g.name, playing: g.playing, visits: g.visits, ageDays, freshDays, lifetimeAvg, currentRate, growth, good, bad, updated: g.updated });
}

const candidates = rows
  .filter((r) => r.good && !r.bad)
  .filter((r) => r.playing >= MIN_CCU && r.playing <= 60000)
  .filter((r) => r.freshDays <= 7)
  .filter((r) => r.ageDays <= 600)
  .filter((r) => r.growth >= 1.5)
  .sort((a, b) => b.growth * Math.log10(b.playing) - a.growth * Math.log10(a.playing));

console.log(`\n符合「Dungeon Lootr 模型」的候选（${candidates.length} 个）：\n`);
console.log(`  增长比   CCU     日访问估  年龄   更新     游戏   (CCU ≥ ${MIN_CCU})`);
for (const r of candidates.slice(0, 20)) {
  console.log(
    `  ${r.growth.toFixed(1).padStart(5)}x  ${String(r.playing).padStart(6)}  ${String(Math.round(r.currentRate / 1000)).padStart(6)}K  ${String(Math.round(r.ageDays)).padStart(4)}天  ${String(Math.round(r.freshDays)).padStart(3)}天前  ${r.name.slice(0, 42)}  [${r.id}]`,
  );
}

// 附：被过滤但增长快的大游戏（供参考）
console.log("\n附：增长比高但 CCU > 60K 的（SERP 大概率锁死，仅供参考）：");
for (const r of rows.filter((r) => r.good && !r.bad && r.playing > 60000 && r.growth >= 2).sort((a, b) => b.growth - a.growth).slice(0, 6)) {
  console.log(`  ${r.growth.toFixed(1).padStart(5)}x  ${String(r.playing).padStart(7)}  ${r.name.slice(0, 42)}  [${r.id}]`);
}

// ─── 写进候选池（2026-10-12，占位纪律 v2 管道）────────────────────────────
// 背景：Clover Time / Steal Anime Eggs 连续两次被对手用「游戏上线」信号抢先注册 .wiki，
// 而 occupy-queue 只吃 candidates.json（Trends/Steam 系信号，比游戏上线天然晚 2-4 周）。
// 本块把 top 15 成长期候选并进 candidates.json（kind=roblox-growth，firstSeen 跨 run 保留），
// occupy-queue 给 roblox-growth 45 分（≥30 即出域名清单）。误报成本 = $15/域 + 12 个月不续纪律，
// 已由 v2 预算模型覆盖；误报率由本扫描器自带的 GOOD/BAD + CCU 甜区 + growth≥1.5 三道闸控制。
{
  const CAND = join(ROOT, "data", "candidates.json");
  const today = new Date().toISOString();
  const pool = existsSync(CAND) ? JSON.parse(readFileSync(CAND, "utf8")) : { candidates: [] };
  const items = Array.isArray(pool) ? pool : pool.candidates || pool.items || [];
  const byId = new Map(items.map((c) => [c.id, c]));
  let added = 0, updated = 0;
  for (const r of candidates.slice(0, 15)) {
    const name = r.name.replace(/^\s*\[[^\]]*\]\s*/g, "").replace(/\s*\[[^\]]*\]\s*$/g, "").trim(); // 去 [NEW]/[UPD]/emoji 角标，否则域名带上 upd/new
    if (!name) continue;
    const id = `roblox-growth-${r.id}`;
    const src = {
      key: `roblox-growth|${r.id}`, sourceId: "roblox-growth",
      name: `Roblox成长 ${r.growth.toFixed(1)}x · CCU ${r.playing}`,
      kind: "roblox-growth", date: today.slice(0, 10), growth: `${r.growth.toFixed(1)}x`,
      firstSeen: today, lastSeen: today,
    };
    const ex = byId.get(id);
    if (ex) {
      ex.lastSeen = today;
      ex.sources ||= [];
      const i = ex.sources.findIndex((s) => s.kind === "roblox-growth");
      if (i >= 0) { src.firstSeen = ex.sources[i].firstSeen || today; ex.sources[i] = src; }
      else ex.sources.push(src);
      updated++;
    } else {
      byId.set(id, {
        id, gameName: name, normalizedName: name.toLowerCase(),
        firstSeen: today, lastSeen: today, status: "new", sources: [src], seo: {},
      });
      added++;
    }
  }
  const out = Array.isArray(pool) ? [...byId.values()] : { ...pool, updatedAt: today, candidates: [...byId.values()] };
  writeFileSync(CAND, JSON.stringify(out, null, 1));
  console.log(`\n候选池并入 roblox-growth：新增 ${added} · 刷新 ${updated}（→ occupy-queue 出域名清单）`);
}
