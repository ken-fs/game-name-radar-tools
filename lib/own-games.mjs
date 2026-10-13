#!/usr/bin/env node
/**
 * own-games.mjs — 自家 Roblox 站清单（雷达排除用）
 *
 * 为什么（2026-10-13）：Anime Mysterious 的站（animemysterious.site）10-12 已上线，
 * 10-13 雷达「今天最值得看」又把它报成 🟢 GO；occupy-queue 还建议买 animemysteriousgame.com。
 * 雷达的价值观是「发现别人家起量的游戏」，自家站命中是纯噪音，还误导用户以为没建站。
 *
 * 数据源：Ship 一级目录所有仓库的 src/** 里出现的 roblox.com/games/<placeId>，
 * placeId → universeId 走 Roblox 官方 API 批量解析，结果缓存 data/own-games.json。
 * 新建站把官方链接写进 site 配置（建站铁律），下一次雷达运行自动带上，不用手工登记。
 *
 * 用法：import { getOwnGames } from "./own-games.mjs"  → { universeIds:Set, names:Set, sites:[] }
 * 单独跑：node lib/own-games.mjs  → 打印清单并刷新缓存
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHIP = join(ROOT, "..");
const CACHE = join(ROOT, "data", "own-games.json");

function cleanName(name) {
  return String(name || "")
    .replace(/^\s*\[[^\]]*\]\s*/g, "")
    .replace(/\s*\[[^\]]*\]\s*$/g, "")
    .replace(/[💥🌌💫🎃🏆🛒🧬⛅🎲✨🔥]/gu, "")
    .trim()
    .toLowerCase();
}

/** 扫 Ship 各仓库 src/** 的 roblox.com/games/<placeId>（取每站出现次数最多的一个，防引用别家） */
export function scanShipSites() {
  const out = new Map(); // dir → placeId
  for (const dir of execSync("ls", { cwd: SHIP, encoding: "utf8" }).split("\n").filter(Boolean)) {
    let ids = [];
    try {
      // 两种写法都抓：① site 配置里的完整 URL（roblox.com/games/<id>）
      // ② 数据文件里的裸 robloxId（holefishing 把 id 存在 src/data/game.config.json，URL 在代码里拼）
      const hit = execSync(
        `grep -rhoE "roblox.com/games/[0-9]+|\\\"robloxId\\\": \\\"[0-9]+" "${dir}/src" --include="*.ts" --include="*.json" --include="*.jsonc" 2>/dev/null | grep -oE "[0-9]+$" | sort | uniq -c | sort -rn | head -1`,
        { cwd: SHIP, encoding: "utf8" },
      ).trim();
      const m = hit.match(/\s(\d+)$/);
      if (m) ids = [m[1]];
    } catch { /* 无匹配 → 非 Roblox 站 */ }
    if (ids.length) out.set(dir, ids[0]);
  }
  return out; // Map<目录名, placeId>
}

/** placeId → universeId，逐个解析（apis.roblox.com 无批量端点；4 次退避重试，查不到记 null） */
async function resolveUniverses(placeIds) {
  const out = {};
  for (const pid of placeIds) {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(`https://apis.roblox.com/universes/v1/places/${pid}/universe`);
        if (res.ok) { out[pid] = String((await res.json()).universeId ?? "") || null; break; }
        if (res.status !== 429 && res.status < 500) { out[pid] = null; break; }
      } catch { /* 网络瞬时错误，走重试 */ }
      if (attempt >= 3) { out[pid] = null; break; }
      await new Promise((r) => setTimeout(r, 3000 * 2 ** attempt));
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return out;
}

/** 缓存不存在或缺 universeId 时重建；返回 { universeIds:Set<string>, names:Set<string>, sites:[{dir,placeId,universeId,name}] } */
export async function getOwnGames({ rebuild = false } = {}) {
  let cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : null;
  if (rebuild || !cache?.sites?.length || cache.sites.some((s) => s.universeId == null)) {
    const dirs = scanShipSites();
    const universes = await resolveUniverses([...dirs.values()]);
    // 拉游戏名（批量，一次 50）
    const uids = Object.values(universes).filter(Boolean);
    const namesByUid = {};
    if (uids.length) {
      try {
        const res = await fetch(`https://games.roblox.com/v1/games?universeIds=${uids.join(",")}`);
        if (res.ok) for (const g of (await res.json()).data ?? []) namesByUid[String(g.id)] = g.name;
      } catch { /* 名字拿不到就只按 universeId 排 */ }
    }
    cache = {
      updatedAt: new Date().toISOString(),
      sites: [...dirs.entries()].map(([dir, placeId]) => ({
        dir, placeId, universeId: universes[placeId] ?? null, name: namesByUid[universes[placeId]] ?? null,
      })),
    };
    writeFileSync(CACHE, JSON.stringify(cache, null, 1));
  }
  const universeIds = new Set(cache.sites.filter((s) => s.universeId).map((s) => String(s.universeId)));
  const names = new Set(cache.sites.filter((s) => s.name).map((s) => cleanName(s.name)));
  return { universeIds, names, sites: cache.sites };
}

export const cleanGameName = cleanName;

if (import.meta.url === `file://${process.argv[1]}`) {
  const { sites } = await getOwnGames({ rebuild: true });
  console.log(`自家 Roblox 站 ${sites.length} 个（→ data/own-games.json，雷达全管线排除）：`);
  for (const s of sites) console.log(`  ${s.dir.padEnd(20)} place ${s.placeId} → universe ${s.universeId ?? "未解析"}  ${s.name ?? ""}`);
}
