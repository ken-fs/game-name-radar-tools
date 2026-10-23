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
import { reportPath } from "../../scripts/lib/reports.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SHIP = join(ROOT, "..");
const CAND = join(ROOT, "data", "candidates.json");
const DOMAIN_CACHE = join(ROOT, "data", "occupy-domains.json");
const STATE = join(ROOT, "data", "occupy-state.json");
const LOG = join(SHIP, "out", "logs", "occupy-queue.log");
const TREG = join(SHIP, "scripts", "treg", "call.py");
const DEMAND_CACHE = join(ROOT, "data", "occupy-demand.json");

// ─── 需求 / 溢价闸门（2026-10-22 加，见 GAME-DECISIONS 当天条目）────────────────
// 🟢 只说明「精确 .wiki 还在」，不说明值得开站：10-22 一批 8 个 🟢 里 0 个值得建站
// （luto 1,600/月主词独苗、trey 2k23 1 搜索/月、Folktography 1 人在线、coinharvest.wiki 半天就被抢）。
// 所以抢域前再过两道闸：
//   需求：主词 ≥300/月 或 Roblox CCU ≥2K 或 Steam 评测 ≥50 —— 全不满足 = 只记录不推
//   溢价：注册局溢价 > $25/年 = 不值期权价（正常 .wiki ~$15 以内）
const WEEK_MS = 7 * 86400e3;
const VOL_MIN = 300, CCU_MIN = 2000, REV_MIN = 50, PREMIUM_MAX = 25;
const GENERIC_WORDS = new Set([
  "indie", "game", "games", "list", "best", "top", "new", "free", "online", "pc", "mobile",
  "awards", "development", "mods", "wiki", "guide", "codes", "horror", "rpg", "simulator",
]);

const TOP = Number(process.argv.find((a) => a.startsWith("--top="))?.slice(6)) || 40;
const NO_NOTIFY = process.argv.includes("--no-notify");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36";

const log = (m) => appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`);

// ─── 信号打分（只认「抢占级」信号：越早越好，不问绝对量）─────────────────────
const STRATEGIC_KINDS = new Set([
  "steam-popular-new", "steam-top-wishlist", "trends-rising-7d", "trends-rising-30d",
  "itch-featured", "itch-popular", "poki-new", "crazygames-new", "y8-new", "gamepix-new",
  "competitor-sitemap", "roblox-growth",
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
    } else if (kind === "roblox-growth") {
      // 2026-10-12：Roblox 成长期扫描入池（Dungeon Lootr 模型已自带三道闸：GOOD/BAD 词、
      // CCU 300-60K 甜区、growth≥1.5）。70 分 = 高于 60 分 Trends 噪音档（una indirecta 类），
      // 低于 98+ 强确认档——玩家行为数据的信号质量优于纯 Trends 联想。
      score += 70; labels.push(s.name || "Roblox成长");
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

// 自家站排除（2026-10-13）：animemysterious 已上线，occupy 还在推销 animemysteriousgame.com
const { getOwnGames, cleanGameName } = await import("./own-games.mjs");
const own = await getOwnGames();

const scored = [];
for (const c of items) {
  if (!c.gameName) continue;
  const uid = String(c.sources?.find((s) => s.kind === "roblox-growth")?.key?.split("|")[1] ?? "");
  if ((uid && own.universeIds.has(uid)) || own.names.has(cleanGameName(c.gameName))) continue;
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

// 闸门数据只给「域名状态已经是 🟢」的候选查（省钱：搜索量按批、Steam 免费、溢价按域）
const demandCache = loadJson(DEMAND_CACHE, {});
await fillGates(top.filter((g) => baseVerdict(g).level === "🟢 抢域"), demandCache);
writeFileSync(DEMAND_CACHE, JSON.stringify(demandCache, null, 1));
const verdict = (g) => applyGates(g, baseVerdict(g), gatesFor(g, demandCache));

// 判定动作（域名状态）
function baseVerdict(g) {
  const ds = domainsFor(g.gameName).map((d) => ({ domain: d, ...(cache[d] || {}) }));
  const wikis = ds.filter((d) => d.domain.endsWith(".wiki"));
  const wiki = wikis.find((d) => d.available) || wikis[0];
  const coms = ds.filter((d) => !d.domain.endsWith(".wiki") && d.available);
  const unknowns = ds.filter((d) => d.available == null).length;
  if (DLC_PATTERN.test(cleanName(g.gameName))) return { ds, level: "🎁 DLC", note: "DLC/通行证，无独立站价值" };
  if (isGenericName(g.gameName)) return { ds, level: "🔤 通用词", note: "不是具体游戏（indie games list 一类），不占位" };
  if (!ds.length) return { ds, level: "📏 长名", note: "名字过长，无可操作域名" };
  if (wiki?.available) return { ds, level: "🟢 抢域", note: `精确 .wiki 可买：${wiki.domain}` };
  if (coms.length) return { ds, level: "🟡 备选", note: `.wiki 被占，可买 ${coms.map((c) => c.domain).join(" / ")}` };
  if (unknowns === ds.length) return { ds, level: "⚠️ 待查", note: "RDAP 全部查询失败——手动重查，别当被占" };
  return { ds, level: "⚪ 记录", note: `全部被占（生态位已有同行）${unknowns ? `｜其中 ${unknowns} 个未查证` : ""}` };
}

// ─── 闸门实现 ────────────────────────────────────────────────────────────────
function loadJson(p, fallback) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fallback; } }
function isGenericName(name) {
  const toks = cleanName(name).toLowerCase().split(/\s+/).map((t) => t.replace(/[^a-z]/g, "")).filter(Boolean);
  return toks.length > 0 && toks.every((t) => GENERIC_WORDS.has(t));
}

/** 批量月搜索量（Serpstat $0.0005/词）。查失败返回 null——查不到≠0，不当计划。 */
function fetchVolumes(words) {
  if (!words.length) return null;
  try {
    const out = execFileSync("python3", ["-I", TREG, "serpstat.google.keywords.volume",
      JSON.stringify({ method: "SerpstatKeywordProcedure.getKeywordsInfo", id: "1",
                       params: { keywords: words.slice(0, 1000), se: "g_us" } })],
      { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"], timeout: 180000,
        env: { ...process.env, TREG_CALLER: "occupy-queue" } });
    const rows = JSON.parse(out)?.result?.data;
    if (!Array.isArray(rows)) return null;
    const idx = Object.fromEntries(rows.map((r) => [String(r.keyword ?? "").toLowerCase(), r.region_queries_count ?? 0]));
    return Object.fromEntries(words.map((w) => [w.toLowerCase(), idx[w.toLowerCase()] ?? 0]));
  } catch { return null; }
}

async function steamReviews(appid) {
  try {
    const r = await fetch(`https://store.steampowered.com/appreviews/${appid}?json=1&language=all&purchase_type=all&num_per_page=0`,
      { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return null;
    return (await r.json())?.query_summary?.total_reviews ?? null;
  } catch { return null; }
}

/** Spaceship 凭据放在 ~/.config/spaceship/env（cron 不读 shell），自己加载 */
function spaceshipEnv() {
  const env = { ...process.env };
  try {
    for (const line of readFileSync(join(process.env.HOME || "", ".config", "spaceship", "env"), "utf8").split("\n")) {
      const i = line.indexOf("=");
      if (i < 0) continue;
      const k = line.slice(0, i).replace(/^export\s+/, "").trim();
      if (k) env[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* 没凭据就跳过溢价检查 */ }
  return env;
}

/** 返回注册价（USD）；标准价 = 0，溢价 = 实际价，查失败 = null */
function spaceshipRegisterPrice(domain) {
  try {
    const out = execFileSync(process.execPath, [join(SHIP, "scripts", "spaceship.mjs"), "check", domain],
      { encoding: "utf8", timeout: 45_000, stdio: ["ignore", "pipe", "ignore"], env: spaceshipEnv() });
    const d = JSON.parse(out.slice(out.indexOf("{")));
    return (d.premiumPricing || []).find((x) => x.operation === "register")?.price ?? 0;
  } catch (e) {
    if (process.env.OQ_DEBUG) console.error("PRICE_ERR", domain, e.message, String(e.stdout || e.stderr || "").slice(0, 200));
    return null;
  }
}

function appIdOf(g) {
  return (g.sources || []).map((s) => String(s.url || "").match(/\/app\/(\d+)/)?.[1]).find(Boolean) || null;
}
function ccuOf(g) {
  const n = (g.sources || []).map((s) => String(s.name || "").match(/CCU (\d+)/)?.[1]).find(Boolean);
  return n ? Number(n) : null;
}

/** 给可能 🟢 的候选补需求/溢价数据（只在缺缓存时花时间/钱） */
async function fillGates(games, cache) {
  const fresh = (k) => cache[k] && Date.now() - Date.parse(cache[k].at || 0) < WEEK_MS;
  // 量只问「游戏意图」写法：光问名字会把同名普通词算进来（luto=西语「服丧」14,800/月、
  // road to ruin=英文成语 880/月、merkado=mercado 拼写 8,100/月）——这正是 10-22 那批 🟢 的坑。
  const FORM = ["game", "codes", "roblox"];
  const words = new Set();
  for (const g of games) {
    const n = cleanName(g.gameName);
    if (fresh(`volg:${n}`) || isGenericName(g.gameName)) continue;
    for (const f of FORM) words.add(`${n.toLowerCase()} ${f}`);
  }
  const vols = fetchVolumes([...words]);
  if (vols) {
    for (const g of games) {
      const n = cleanName(g.gameName);
      if (isGenericName(g.gameName) || !words.has(`${n.toLowerCase()} game`)) continue;
      const forms = Object.fromEntries(FORM.map((f) => [f, vols[`${n.toLowerCase()} ${f}`] ?? 0]));
      cache[`volg:${n}`] = { value: Math.max(...Object.values(forms)), forms, at: new Date().toISOString() };
    }
  }
  for (const g of games) {
    const id = appIdOf(g);
    if (!id || fresh(`rev:${id}`)) continue;
    const n = await steamReviews(id);
    if (n != null) cache[`rev:${id}`] = { value: n, at: new Date().toISOString() };
  }
  for (const g of games) {
    const w = baseVerdict(g).ds.find((d) => d.domain.endsWith(".wiki") && d.available);
    if (!w || fresh(`prem:${w.domain}`)) continue;
    const p = spaceshipRegisterPrice(w.domain);
    if (process.env.OQ_DEBUG) console.error("PREM", w.domain, p);
    if (p != null) cache[`prem:${w.domain}`] = { value: p, at: new Date().toISOString() };
  }
}

function gatesFor(g, cache) {
  const n = cleanName(g.gameName);
  const id = appIdOf(g);
  const w = baseVerdict(g).ds.find((d) => d.domain.endsWith(".wiki"));
  return {
    volume: isGenericName(g.gameName) ? null : (cache[`volg:${n}`]?.value ?? null),
    reviews: id ? (cache[`rev:${id}`]?.value ?? null) : null,
    ccu: ccuOf(g),
    premium: w ? (cache[`prem:${w.domain}`]?.value ?? null) : null,
  };
}

function applyGates(g, base, gate) {
  if (base.level !== "🟢 抢域") return base;
  const bits = [
    gate.volume != null ? `游戏意图 ${gate.volume}/月` : "量未查到",
    gate.ccu ? `CCU ${gate.ccu}` : null,
    gate.reviews != null ? `评测 ${gate.reviews}` : null,
  ].filter(Boolean).join(" · ");
  const demandOk = (gate.volume ?? 0) >= VOL_MIN || (gate.ccu ?? 0) >= CCU_MIN || (gate.reviews ?? 0) >= REV_MIN;
  if (!demandOk) return { ...base, level: "🔇 需求不足", note: `域名在，但需求没到门槛（${bits}）—— 只记录，别当天抢` };
  if ((gate.premium ?? 0) > PREMIUM_MAX) {
    return { ...base, level: "💸 溢价", note: `.wiki 在但注册局溢价 $${gate.premium}/年 —— 不值期权价（${bits}）` };
  }
  return { ...base, note: `${base.note}（${bits}）` };
}

const prevState = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { notifiedDomains: [] };
const notified = new Set(prevState.notifiedDomains || []);
const freshGreens = [];

const lines = [];
lines.push(`# 占位队列 ${new Date().toISOString().slice(0, 10)}`);
lines.push("");
lines.push(`> 信号刚起的候选（近 ${FRESH / 86400e3} 天首次出现 + 近 ${ACTIVE / 86400e3} 天有活动 + 抢占级信号 ≥30）。`);
lines.push(`> 动作：🟢 = 精确 .wiki 还在且过闸（主词 ≥${VOL_MIN}/月 或 Roblox CCU ≥${CCU_MIN} 或 Steam 评测 ≥${REV_MIN}，且非注册局溢价），当天抢；🟡 = .wiki 没了，考虑备选 .com；⚪ = 生态位已被占，只记录。`);
lines.push(`> 🔇 需求不足 / 💸 溢价 / 🔤 通用词 = 域名在但不值得抢（2026-10-22 加，起因：一批 8 个 🟢 里 0 个值得建站）。`);
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

const outFile = reportPath(`OCCUPY-${new Date().toISOString().slice(0, 10)}.md`);
writeFileSync(outFile, lines.join("\n"));

const count = (lv) => top.filter((g) => verdict(g).level === lv).length;
const greens = count("🟢 抢域"), yellows = count("🟡 备选"), muted = count("🔇 需求不足") + count("💸 溢价") + count("🔤 通用词");
log(`OCCUPY ${top.length} candidates | 🟢${greens} 🟡${yellows} 被闸门挡${muted} | fresh greens: ${freshGreens.map((f) => f.domain).join(",") || "-"}`);

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
console.log(`占位队列：${top.length} 个候选（🟢${greens} 🟡${yellows} 闸门挡掉${muted}）→ ${outFile}`);
for (const g of top.slice(0, 12)) {
  const v = verdict(g);
  const doms = v.ds.map((d) => (d.available ? `✅${d.domain}` : d.available === false ? `❌${d.domain}` : `⚠️${d.domain}`)).join(" ");
  console.log(`${v.level} [${String(g._sig.score).padStart(3)}] ${g.gameName.slice(0, 34).padEnd(36)} ${doms}`);
}
