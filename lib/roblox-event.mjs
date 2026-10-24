// Roblox 官方限时活动识别（2026-10-24 加）
//
// 「Roblox Presents」组（group 4111519）出的是平台级限时活动：The Hunt: Roblox 20（2026-09）、
// The Hollow（2026-10-13 上线、10-31 结束，上线 11 天 3,800 万访问、4 万在线）。雷达按普通游戏估月量
// （The Hollow 被估成 200K/月），可活动一结束搜索就归零——thehuntroblox20.xyz 9-29 上线，10-02 峰值
// 203 点击/天，10-13 归零，一共 523 点击。所以这类词要标出来：报截止日期，不按月量排，不买新域名。
//
//   import { robloxEvent, eventNote } from "./lib/roblox-event.mjs";
//   const ev = await robloxEvent(universeId);   // 不是官方活动 / 查询失败 → null
//   if (ev) console.log(eventNote(ev));

export const OFFICIAL_EVENT_GROUPS = new Map([[4111519, "Roblox Presents"]]);

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DATE_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi;

/** 描述里提到的最晚日期（活动描述一般写「until / on October 31」）；年份按上线时间推。 */
export function endDateFrom(description, createdAt) {
  const created = new Date(createdAt);
  const base = Number.isFinite(created.getTime()) ? created : new Date();
  let best = null;
  for (const m of String(description ?? "").matchAll(DATE_RE)) {
    const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    const day = Number(m[2]);
    if (month < 0 || day < 1 || day > 31) continue;
    let d = new Date(Date.UTC(base.getUTCFullYear(), month, day));
    if (d < base - 30 * 864e5) d = new Date(Date.UTC(base.getUTCFullYear() + 1, month, day)); // 12 月上线写「January 5」
    if (!best || d > best) best = d;
  }
  return best;
}

/** 官方活动 → { group, name, endsAt: Date|null, daysLeft: number|null }；否则 null。 */
export async function robloxEvent(universeId, { now = Date.now() } = {}) {
  if (!universeId) return null;
  let g;
  try {
    const res = await fetch(`https://games.roblox.com/v1/games?universeIds=${universeId}`, { signal: AbortSignal.timeout(15_000) });
    g = (await res.json())?.data?.[0];
  } catch {
    return null;
  }
  const group = g?.creator?.type === "Group" ? OFFICIAL_EVENT_GROUPS.get(Number(g.creator.id)) : undefined;
  if (!group) return null;
  const endsAt = endDateFrom(g.description, g.created);
  // 截止日当天还算 1 天
  const daysLeft = endsAt ? Math.max(0, Math.ceil((endsAt.getTime() + 864e5 - now) / 864e5)) : null;
  return { group, name: g.name, endsAt, daysLeft };
}

const md = (d) => `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;

/** 一行提示，推送 / 报告 / 单查共用。 */
export function eventNote(ev, { short = false } = {}) {
  const end = ev.endsAt ? `截止 ${md(ev.endsAt)}（剩 ${ev.daysLeft} 天）` : "截止日没写（The Hunt 前后约 2 周）";
  if (short) return `⏳ 官方限时活动 · ${end}`;
  return `⏳ 官方限时活动（${ev.group}）· ${end}——活动一结束搜索归零，月量估算不作数；别买新域名，要做就在现有活动站 thehuntroblox20.xyz 加页抢收尾长尾（先例 The Hunt：上线 3 天到峰值 203 点击/天，活动结束即归零，共 523 点击）`;
}

/** 只有词名时（TrendOracle 订阅推送）：Roblox 搜索取名字一致、在线最多的那个，再判是不是官方活动。 */
export async function robloxEventByName(name, opts) {
  const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  try {
    const res = await fetch(
      `https://apis.roblox.com/search-api/omni-search?searchQuery=${encodeURIComponent(name)}&sessionId=radar&pageType=all`,
      { signal: AbortSignal.timeout(15_000) },
    );
    const games = ((await res.json())?.searchResults ?? []).flatMap((r) => r.contents ?? []).filter((c) => c.contentType === "Game");
    const hit = games.filter((g) => norm(g.name).includes(norm(name))).sort((a, b) => (b.playerCount ?? 0) - (a.playerCount ?? 0))[0];
    return hit ? await robloxEvent(hit.universeId, opts) : null;
  } catch {
    return null;
  }
}
