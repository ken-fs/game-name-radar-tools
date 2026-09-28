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
const SORTS = ["up-and-coming", "top-trending", "top-playing-now", "fun-with-friends", "top-rated"];
// 多国扫描（2026-09-28）：sorts 按 IP 地理个性化且每榜 ~30 条无分页，单国会丢游戏
const COUNTRIES = ["us", "br", "ph", "mx", "id", "th", "gb", "de", "fr", "jp", "kr"];
const MIN_CCU = Number((process.argv.find((a) => a.startsWith("--min-ccu=")) ?? "").split("=")[1]) || 300;

// 数据型需求加分词 / 排除词
const GOOD = /(codes?|unit|pet|egg|loot|evolve|hatch|forge|anime|simulator|clicker|incremental|tier|class|weapon|sword|aura|fruit|dungeon|quest|grind|rarity|rarities)/i;
const BAD = /(obby|roleplay|\bRP\b|hangout|shooter|\bgun\b|horror|escape|survive the|tycoon)/i;

const now = Date.now();

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.slice(0, 80)}`);
  return res.json();
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
const rows = [];
for (const g of details) {
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
