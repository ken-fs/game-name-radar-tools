#!/usr/bin/env node
/**
 * youtube-discovery.mjs — YouTube 信号源（游戏发现）
 *
 * 目的：榜单扫描的补充信号源——YouTube 创作者比榜单更早报道新游戏/新更新。
 * 流程：搜索近期游戏视频 → 从标题提取游戏名 → Roblox 搜索验证 → 拉数据 → 排名
 *
 * 用法：
 *   NODE_USE_ENV_PROXY=1 https_proxy=http://127.0.0.1:7897 node lib/youtube-discovery.mjs
 *   node lib/youtube-discovery.mjs --min-ccu=300 --days=14
 *
 * 输出：候选表（游戏名 / CCU / 增长比 / 视频证据）
 */
import { execFileSync } from "node:child_process";

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : dflt;
};
const MIN_CCU = Number(arg("min-ccu", 300));
const MAX_AGE_DAYS = Number(arg("max-age", 600));

// 搜索词：覆盖「新游戏」「更新」「codes」三类创作者报道
const QUERIES = [
  "roblox codes",
  "roblox new update",
  "roblox new game",
  "roblox simulator update",
  "roblox new codes working",
  "roblox update today new",
];

// 标题里常见的非游戏词（避免误提取）
const STOP = new Set([
  "roblox", "update", "updates", "new", "codes", "code", "the", "a", "an", "in", "on", "for",
  "best", "top", "how", "to", "get", "all", "and", "or", "of", "with", "this", "that", "my",
  "i", "you", "it", "is", "are", "was", "be", "game", "games", "playing", "play", "today",
  "insane", "op", "huge", "big", "secret", "free", "working", "everything", "need", "know",
  "official", "trailer", "release", "showcase", "guide", "tier", "list", "vs", "but", "not",
  "ultimate", "noob", "pro", "max", "first", "last", "part", "live", "stream", "video",
  "shorts", "short", "fyp", "viral", "subscribe", "like", "comment", "giveaway", "give",
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ytSearch(query, n = 12) {
  try {
    const out = execFileSync(
      "yt-dlp",
      ["--flat-playlist", "--print", "%(id)s\t%(title)s\t%(view_count)s", `ytsearch${n}:${query}`],
      { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "ignore"] },
    );
    return out
      .trim()
      .split("\n")
      .map((line) => {
        const [id, title, views] = line.split("\t");
        return { id, title: title ?? "", views: Number(views) || 0 };
      })
      .filter((v) => v.id && v.title);
  } catch {
    return [];
  }
}

/** 从视频描述提取 Roblox 游戏链接（创作者都会贴官方链接——比标题解析可靠得多） */
function extractGameIds(description) {
  const ids = new Set();
  // roblox.com/games/<id>/<slug> 或 /games/<id>
  for (const m of description.matchAll(/roblox\.com\/games\/(\d{6,})/g)) ids.add(m[1]);
  return [...ids];
}

function videoMeta(videoId) {
  try {
    const out = execFileSync("yt-dlp", ["--print", "%(upload_date)s\n%(description)s", "--skip-download", `https://www.youtube.com/watch?v=${videoId}`], {
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const nl = out.indexOf("\n");
    return { uploadDate: out.slice(0, nl).trim(), description: out.slice(nl + 1) };
  } catch {
    return { uploadDate: "", description: "" };
  }
}

/** upload_date 是 YYYYMMDD；返回距今天数（无日期返回 Infinity） */
function daysSince(uploadDate) {
  if (!/^\d{8}$/.test(uploadDate)) return Infinity;
  const d = Date.parse(`${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`);
  return (Date.now() - d) / 864e5;
}

async function robloxLookup(name) {
  const url = `https://apis.roblox.com/search-api/omni-search?searchQuery=${encodeURIComponent(name)}&sessionId=ytdisc&pageType=all`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const d = await res.json();
    for (const grp of d.searchResults ?? []) {
      for (const c of grp.contents ?? []) {
        if (!c.universeId) continue;
        const t = (c.name ?? "").toLowerCase();
        const q = name.toLowerCase();
        if (t.includes(q) || q.includes(t.replace(/[[\](){}]/g, "").trim())) {
          return { universeId: String(c.universeId), robloxName: c.name, playerCount: c.playerCount };
        }
      }
    }
  } catch {
    /* 网络抖动忽略 */
  }
  return null;
}

async function gameStats(universeId) {
  try {
    const res = await fetch(`https://games.roblox.com/v1/games?universeIds=${universeId}`, {
      signal: AbortSignal.timeout(15_000),
    });
    const d = await res.json();
    return d.data?.[0] ?? null;
  } catch {
    return null;
  }
}

// ── 主流程 ──
console.log("═══ YouTube 信号源 · 游戏发现（描述链接法）═══\n");
const placeIds = new Map(); // placeId → { videos: number, sample: string }
for (const q of QUERIES) {
  const vids = ytSearch(q, 8);
  console.log(`  [${q}] → ${vids.length} 视频，抓描述…`);
  for (const v of vids) {
    const { uploadDate, description } = videoMeta(v.id);
    if (daysSince(uploadDate) > 30) continue; // 只收近 30 天视频
    for (const pid of extractGameIds(description)) {
      const rec = placeIds.get(pid) ?? { videos: 0, sample: v.title.slice(0, 65) };
      rec.videos += 1;
      placeIds.set(pid, rec);
    }
    await sleep(300);
  }
  await sleep(1000);
}
console.log(`\n从描述中提取到 ${placeIds.size} 个 Roblox 游戏链接，解析并拉数据…\n`);

async function placeToUniverse(placeId) {
  try {
    const res = await fetch(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`, { signal: AbortSignal.timeout(15_000) });
    const d = await res.json();
    return d.universeId ? String(d.universeId) : null;
  } catch {
    return null;
  }
}

const now = Date.now();
const results = [];
for (const [pid, ev] of placeIds) {
  const uid = await placeToUniverse(pid);
  if (!uid) continue;
  const g = await gameStats(uid);
  if (!g) continue;
  const ageDays = (now - Date.parse(g.created)) / 864e5;
  if (ageDays > MAX_AGE_DAYS) continue;
  const lifetimeAvg = (g.visits ?? 0) / Math.max(1, ageDays);
  const growth = lifetimeAvg ? (g.playing * 60) / lifetimeAvg : 0;
  const freshDays = (now - Date.parse(g.updated)) / 864e5;
  if ((g.playing ?? 0) < MIN_CCU || (g.playing ?? 0) > 60_000) continue;
  if (freshDays > 14) continue;
  results.push({
    name: (g.name ?? "").slice(0, 42),
    id: uid,
    playing: g.playing,
    growth,
    ageDays: Math.round(ageDays),
    freshDays: Math.round(freshDays),
    vids: ev.videos,
    sample: ev.sample,
  });
  await sleep(350);
}

results.sort((a, b) => b.growth * Math.log10(Math.max(10, b.playing)) - a.growth * Math.log10(Math.max(10, a.playing)));
console.log("  增长比   CCU     年龄   更新  视频数  游戏（视频证据）");
console.log("  " + "─".repeat(100));
for (const r of results.slice(0, 25)) {
  console.log(
    `  ${r.growth.toFixed(1).padStart(5)}x  ${String(r.playing).padStart(6)}  ${String(r.ageDays).padStart(4)}天  ${String(r.freshDays).padStart(3)}天前  ${String(r.vids).padStart(3)}个  ${r.name}  [${r.id}]`,
  );
  console.log(`        └─ ${r.sample}`);
}
console.log(`\n共 ${results.length} 个通过筛选（CCU ≥ ${MIN_CCU} · 14 天内更新 · ≤${MAX_AGE_DAYS} 天建游）`);
