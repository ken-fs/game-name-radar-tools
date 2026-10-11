#!/usr/bin/env node
/**
 * 占位队列（occupy queue）— 把「发现」当天变成「可抢的域」。
 *
 * 为什么：候选池每天新增 ~70 个词、积压 2600+ pending——判决层堵死的结果是
 * BOMBANANA 抓到了、躺 10 天、同行 9 个 wiki 域名围上来了（2026-10-11 复盘）。
 * .wiki 生态位的现实是：等「强信号」= 已经晚了（同行的 playbook 是词表落地几小时内抢域）。
 * 所以这个脚本做的是：信号刚起 (<N天) 的高分候选 → 当天出「域名 ✅/❌ + 抢/不抢」清单，
 * 让占位决策从「几周一次"等验证"」变成「每天一次，5 分钟看完」。
 *
 * 分工：本脚本 = 抢占级信号（弱信号 + 域名状态），贵验证（SERP/投入价值）留给拿到域之后。
 * 成本：零。候选池（已有）+ RDAP（免费）+ 本地缓存。
 *
 * cron: daily.sh 尾部调用（每天一次，跟雷达一起）
 * 手动: node lib/occupy-queue.mjs [--top=30] [--no-notify]
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { domainSlug } from "./invest-score.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SHIP = join(ROOT, "..");
const CAND = join(ROOT, "data", "candidates.json");
const DOMAIN_CACHE = join(ROOT, "data", "occupy-domains.json");
const STATE = join(ROOT, "data", "occupy-state.json");
const LOG = join(SHIP, "out", "logs", "occupy-queue.log");

const TOP = Number(process.argv.find((a) => a.startsWith("--top="))?.slice(6)) || 40;
const NO_NOTIFY = process.argv.includes("--no-notify");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36";

const log = (m) => appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`);

// ─── 信号打分（只认「抢占级」信号：越早越好，不问绝对量）─────────────────────
const STRATEGIC_KINDS = new Set([
  "steam-popular-new", "steam-top-wishlist", "trends-rising-7d", "trends-rising-30d",
  "itch-featured", "itch-popular", "poki-new", "crazygames-new", "y8-new", "gamepix-new",
  "competitor-sitemap",
]);

function signalScore(c) {
  let score = 0;
  const labels = [];
  const stratSources = new Set();
  for (const s of c.sources || []) {
    const kind = s.kind;
    if (!STRATEGIC_KINDS.has(kind)) continue;
    stratSources.add(kind);
    if (kind === "steam-popular-new" && s.currentRank) {
      score += Math.max(0, 70 - s.currentRank);
      labels.push(`Steam热新 #${s.currentRank}`);
    } else if (kind === "steam-top-wishlist" && s.currentRank) {
      score += Math.max(0, 60 - s.currentRank * 0.6);
      labels.push(`愿望单 #${s.currentRank}`);
    } else if (kind === "trends-rising-7d") {
      const g = s.growth === "Breakout" ? 60 : Math.min(60, Number(String(s.growth).replace(/[+%]/g, "")) * 0.6 || 0);
      score += g;
      labels.push(`Trends7d ${s.growth}`);
    } else if (kind === "trends-rising-30d") {
      const g = s.growth === "Breakout" ? 40 : Math.min(40, Number(String(s.growth).replace(/[+%]/g, "")) * 0.4 || 0);
      score += g;
      labels.push(`Trends30d ${s.growth}`);
    } else if (kind === "itch-featured") { score += 25; labels.push("itch 精选"); }
    else if (kind === "itch-popular") { score += 15; labels.push("itch 热门"); }
    else if (kind.endsWith("-new")) { score += 18; labels.push(s.name || kind); }
  }
  // 多源共振加成
  if (stratSources.size >= 2) score += Math.min(20, (stratSources.size - 1) * 10);
  // SEO 信号：联想词里有真玩家词
  const seo = c.seo || {};
  if ((seo.suggestionGameCount || 0) >= 3) { score += 10; labels.push(`联想 ${seo.suggestionGameCount} 条`); }
  else if ((seo.suggestionGameCount || 0) >= 1) score += 4;
  if ((seo.exactGameRatio || 0) >= 0.3) score += 8;
  return { score: Math.round(score), labels, kinds: stratSources.size };
}

// ─── 域名生成 + RDAP（带 7 天缓存）────────────────────────────────────────────
function loadDomainCache() {
  try { return JSON.parse(readFileSync(DOMAIN_CACHE, "utf8")); } catch { return {}; }
}

async function rdapOnce(domain) {
  const res = await fetch(`https://rdap.org/domain/${domain}`, {
    headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(25_000),
  });
  if (res.status === 404) return { available: true };
  if (!res.ok) return { available: null };
  const d = await res.json().catch(() => ({}));
  const reg = (d.events || []).find((e) => e.eventAction === "registration")?.eventDate?.slice(0, 10) || null;
  const ns = (d.nameservers || []).map((n) => n.ldhName || "").join(",");
  return { available: false, registered: reg, ns };
}

/** 重试一次：RDAP 走注册局端点，并发高时会限流/超时——查失败≠被占，必须能区分 */
async function rdap(domain) {
  for (let i = 0; i < 2; i++) {
    try {
      const r = await rdapOnce(domain);
      if (r.available !== null) return r;
    } catch {}
    if (i === 0) await new Promise((res) => setTimeout(res, 1500));
  }
  return { available: null };
}

/** Trends 上升词常是「游戏名 + 平台/体裁/年份」的搜索短语，去掉尾部噪音后才对得上域。 */
const NAME_NOISE = new Set([
  "ps5", "ps4", "xbox", "switch", "switch2", "pc", "steam", "roblox", "mobile", "android", "ios",
  "game", "games", "gameplay", "horror", "release", "date", "wiki", "trailer", "new", "update",
  "expansion", "dlc", "edition", "deluxe", "remaster", "remake", "definitive",
  "2024", "2025", "2026", "2027",
]);
function cleanName(name) {
  let s = String(name).trim();
  // Trends 种子词前缀噪音（“horror game i see a hottie”→ 去掉“horror game”）；只限这个多词短语，避免误伤 Game of Thrones 类
  s = s.replace(/^horror\s+game[:\s-]+/i, "");
  const words = s.split(/\s+/);
  while (words.length > 1 && NAME_NOISE.has(words[words.length - 1].toLowerCase().replace(/[™®©!?.,'":-]/g, ""))) {
    words.pop();
  }
  return words.join(" ");
}

/** 短品牌段：“Dragon's Dogma 2: Dark Arisen Expansion” → “Dark Arisen”——长名游戏能打的域常是尾段品牌词。 */
function shortName(name) {
  const parts = String(name).split(/[:–—|]/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const s = cleanName(parts[parts.length - 1]);
  return s.length >= 4 && domainSlug(s).length <= 20 ? s : null;
}

/** DLC/通行证类：没有独立站价值（就一格内容），不进抢域清单。 */
const DLC_PATTERN = /season pass|collector set|battle pass|starter pack|bundle|\bpass\b/i;

function domainsFor(game) {
  const names = [cleanName(game)];
  const short = shortName(game);
  if (short && short !== names[0]) names.push(short);
  const out = [];
  for (const n of names) {
    const slug = domainSlug(n);
    if (slug.length < 4 || slug.length > 26) continue;
    for (const d of [`${slug}.wiki`, `${slug}game.com`, `${slug}wiki.com`]) {
      if (!out.includes(d)) out.push(d);
    }
  }
  return out;
}

async function checkDomains(games, cache) {
  const week = 7 * 86400e3;
  // 先全局回填：任何历史 null（旧版并发失败的陈货）降级为「8 天前查过」，逼它进 todo 重查；
  // 只对当轮 todo 回填的话，陈货永远不进 todo、永远不重查（今天踩过的坑）。
  for (const [d, hit] of Object.entries(cache)) {
    if (hit?.available === null && Date.now() - Date.parse(hit.checkedAt || 0) < 7 * 86400e3) {
      cache[d] = { ...hit, checkedAt: new Date(Date.now() - 8 * 86400e3).toISOString().slice(0, 10) };
    }
  }
  const todo = [];
  for (const g of games) {
    for (const d of domainsFor(g.gameName)) {
      const hit = cache[d];
      if (!hit || Date.now() - Date.parse(hit.checkedAt) > week) todo.push(d);
    }
  }
  const unique = [...new Set(todo)];
  let i = 0;
  async function worker() {
    while (i < unique.length) {
      const d = unique[i++];
      cache[d] = { ...(await rdap(d)), checkedAt: new Date().toISOString().slice(0, 10) };
      await new Promise((r) => setTimeout(r, 400)); // RDAP 礼貌限速（并发 6 时限流过，降到 3）
    }
  }
  await Promise.all(Array.from({ length: 3 }, worker));
  return cache;
}

// ─── 主流程 ─────────────────────────────────────────────────────────────────
const raw = JSON.parse(readFileSync(CAND, "utf8"));
const items = Array.isArray(raw) ? raw : raw.candidates || raw.items || [];
const now = Date.now();
const FRESH = 21 * 86400e3;
const ACTIVE = 5 * 86400e3;

const scored = [];
for (const c of items) {
  if (!c.gameName) continue;
  if (c.seo?.classification === "reject" || c.seo?.classification === "error") continue;
  const first = Date.parse(c.firstSeen || 0);
  const last = Date.parse(c.lastSeen || 0);
  if (now - first > FRESH || now - last > ACTIVE) continue;
  const sig = signalScore(c);
  if (sig.score < 30) continue;
  scored.push({ ...c, _sig: sig });
}
scored.sort((a, b) => b._sig.score - a._sig.score);
const top = scored.slice(0, TOP);

const cache = loadDomainCache();
await checkDomains(top, cache);
writeFileSync(DOMAIN_CACHE, JSON.stringify(cache, null, 1));

// 判定动作
function verdict(g) {
  const ds = domainsFor(g.gameName).map((d) => ({ domain: d, ...(cache[d] || {}) }));
  const wikis = ds.filter((d) => d.domain.endsWith(".wiki"));
  const wiki = wikis.find((d) => d.available) || wikis[0];
  const coms = ds.filter((d) => !d.domain.endsWith(".wiki") && d.available);
  const unknowns = ds.filter((d) => d.available == null).length;
  if (DLC_PATTERN.test(cleanName(g.gameName))) return { ds, level: "🎁 DLC", note: "DLC/通行证，无独立站价值" };
  if (!ds.length) return { ds, level: "📏 长名", note: "名字过长，无可操作域名" };
  if (wiki?.available) return { ds, level: "🟢 抢域", note: `精确 .wiki 可买：${wiki.domain}` };
  if (coms.length) return { ds, level: "🟡 备选", note: `.wiki 被占，可买 ${coms.map((c) => c.domain).join(" / ")}` };
  if (unknowns === ds.length) return { ds, level: "⚠️ 待查", note: "RDAP 全部查询失败——手动重查，别当被占" };
  return { ds, level: "⚪ 记录", note: `全部被占（生态位已有同行）${unknowns ? `｜其中 ${unknowns} 个未查证` : ""}` };
}

const prevState = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { notifiedDomains: [] };
const notified = new Set(prevState.notifiedDomains || []);
const freshGreens = [];

const lines = [];
lines.push(`# 占位队列 ${new Date().toISOString().slice(0, 10)}`);
lines.push("");
lines.push(`> 信号刚起的候选（近 ${FRESH / 86400e3} 天首次出现 + 近 ${ACTIVE / 86400e3} 天有活动 + 抢占级信号 ≥30）。`);
lines.push(`> 动作：🟢 = 精确 .wiki 还在，当天抢；🟡 = .wiki 没了，考虑备选 .com；⚪ = 生态位已被占，只记录。`);
lines.push("");

for (const g of top) {
  const v = verdict(g);
  const wiki = v.ds.find((d) => d.domain?.endsWith(".wiki"));
  if (v.level === "🟢 抢域" && wiki && !notified.has(wiki.domain)) {
    freshGreens.push({ game: g.gameName, domain: wiki.domain, score: g._sig.score, labels: g._sig.labels });
    notified.add(wiki.domain);
  }
  const domainCells = v.ds.map((d) => {
    if (d.available) return `✅ ${d.domain}`;
    if (d.available === false) return `❌ ${d.domain}${d.registered ? ` (${d.registered})` : ""}`;
    return `⚠️ ${d.domain} (查询失败)`;
  }).join(" · ");
  lines.push(`## ${v.level} · ${cleanName(g.gameName)}（信号 ${g._sig.score}）`);
  lines.push("");
  lines.push(`- 信号：${g._sig.labels.join(" · ")}｜首次 ${(g.firstSeen || "").slice(0, 10)}`);
  lines.push(`- 域名：${domainCells}`);
  if (g.seo?.suggestions?.length) {
    lines.push(`- 联想词样本：${g.seo.suggestions.slice(0, 5).join(" / ")}`);
  }
  lines.push(`- 建议：${v.note}${g.seo?.nameRisk >= 8 ? "（⚠️ 名字通用风险高，建站前先过 SERP 闸门）" : ""}`);
  lines.push("");
}

const outFile = join(SHIP, `OCCUPY-${new Date().toISOString().slice(0, 10)}.md`);
writeFileSync(outFile, lines.join("\n"));

const greens = top.filter((g) => verdict(g).level === "🟢 抢域").length;
const yellows = top.filter((g) => verdict(g).level === "🟡 备选").length;
log(`OCCUPY ${top.length} candidates | 🟢${greens} 🟡${yellows} | fresh greens: ${freshGreens.map((f) => f.domain).join(",") || "-"}`);

// 通知：只推「今天新出现的 🟢 域」，避免天天重复
if (!NO_NOTIFY && freshGreens.length) {
  const top3 = freshGreens.slice(0, 3);
  const body = top3.map((f) => `${f.game} → ${f.domain}`).join("；") +
    (freshGreens.length > 3 ? ` 等 ${freshGreens.length} 个` : "");
  try {
    execFileSync(process.execPath, [join(SHIP, "scripts", "notify.mjs"), "--title", "🟢 可抢域名", "--body", body], { stdio: "ignore", timeout: 30_000 });
  } catch {}
  try {
    execFileSync("osascript", ["-e", `display notification "${body.slice(0, 200).replace(/"/g, '')}" with title "🟢 可抢域名" sound name "Glass"`], { stdio: "ignore" });
  } catch {}
}

writeFileSync(STATE, JSON.stringify({ lastRun: new Date().toISOString(), notifiedDomains: [...notified] }, null, 1));
console.log(`占位队列：${top.length} 个候选（🟢${greens} 🟡${yellows}）→ ${outFile}`);
for (const g of top.slice(0, 12)) {
  const v = verdict(g);
  const doms = v.ds.map((d) => (d.available ? `✅${d.domain}` : d.available === false ? `❌${d.domain}` : `⚠️${d.domain}`)).join(" ");
  console.log(`${v.level} [${String(g._sig.score).padStart(3)}] ${g.gameName.slice(0, 34).padEnd(36)} ${doms}`);
}
