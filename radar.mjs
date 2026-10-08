#!/usr/bin/env node
/**
 * radar.mjs — 游戏雷达统一入口（2026-10-08 加）
 *
 * 以前要分开跑 Roblox / Steam / 可玩游戏 / 梗 四套雷达，记不住该用哪个。现在两种用法：
 *
 *   node radar.mjs                    # 今日总报告 → ../RADAR-<日期>.md
 *       读当天每日管线（scripts/scan.mjs，launchd 08:30）产出的 Steam 投入价值 / 可玩游戏 /
 *       梗游戏三份报告，再现跑 Roblox 层（成长期扫描 + YouTube 错配 + 前几名的需求验证），
 *       汇总成一份，最上面是「今天最值得看」。launchd 在 scan.mjs 之后接着跑它。
 *
 *   node radar.mjs check "名字" [...]  # 单查一个或几个游戏 / 梗，自动判断该走哪条线：
 *       Roblox 上搜得到 → Roblox 需求验证（Trends 曲线 + 攻略子词）
 *       Steam 上搜得到  → Steam 工具闸门 + 投入价值五维评分
 *       都没有          → 可玩游戏走势 + 梗雷达（高 CPM 市场本地语言联想）
 *       同名多平台都有的，几条线都跑。
 *
 * 只做编排：各模块原样调用（子进程），不改它们的逻辑。全部零搜索额度
 * （Roblox 官方 API、yt-dlp、Google Suggest / Trends）。
 *
 *   node radar.mjs --skip-roblox      # 只汇总当天已有报告（Roblox 层慢，约 5–15 分钟）
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIP = join(HERE, "..");
const today = new Date().toLocaleDateString("sv-SE");
const args = process.argv.slice(2);

/** 跑一个模块，返回 stdout（失败也返回已有输出，绝不抛）。 */
function run(file, argv = [], timeoutMs = 30 * 60_000) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--env-file-if-exists=.env", join(HERE, file), ...argv],
      { cwd: HERE, maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs, env: process.env },
      (error, stdout, stderr) => {
        const out = String(stdout || "");
        if (error && !out) {
          resolve(`⚠️ ${file} 失败：${String(stderr || error.message).split("\n").find((l) => l.trim()) ?? error.message}`);
          return;
        }
        resolve(out);
      },
    );
  });
}

/** Roblox 名字去掉 [UPDATE] / 🎃 这类装饰，留给 Trends 和 SERP 用。 */
export function cleanRobloxName(name) {
  return name
    .replace(/\[[^\]]*\]|\([^)]*\)|【[^】]*】/g, " ")
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/[!?.:,]+$/g, "")
    .trim();
}

// ─── Roblox 层 ────────────────────────────────────────────────────────────────

const GROWTH_ROW = /^\s+([\d.]+)x\s+(\d+)\s+([\d.]+[KM]?)\s+(\d+)天\s+(\d+)天前\s+(.+?)\s+\[(\d+)\]\s*$/;
const MISMATCH_ROW = /^\s+(🎣🎣|🎣)\s+([\d.]+)\s+(\d+)\s+([\d,]+)\s+(\d+)\s+(.+?)\s+\[(\d+)\]/;

export function parseGrowth(text) {
  return text
    .split("\n")
    .map((line) => line.match(GROWTH_ROW))
    .filter(Boolean)
    .map((m) => ({ ageDays: Number(m[4]), ccu: Number(m[2]), growth: Number(m[1]), id: m[7], name: m[6].trim(), updatedDaysAgo: Number(m[5]) }));
}

export function parseMismatch(text) {
  return text
    .split("\n")
    .map((line) => line.match(MISMATCH_ROW))
    .filter(Boolean)
    .map((m) => ({ ccu: Number(m[5]), channels: Number(m[3]), flag: m[1], id: m[7], name: m[6].trim(), ratio: Number(m[2]) }));
}

export function parseDemand(text) {
  const out = [];
  let current = null;
  for (const line of text.split("\n")) {
    const head = line.match(/^── (.+)$/);
    if (head) {
      current = { name: head[1].trim(), verdict: "", reason: "", trend: "", magnitude: "", sub: "" };
      out.push(current);
      continue;
    }
    if (!current) continue;
    const verdict = line.match(/判决:\s*(.+?)\s*—\s*(.+)$/);
    if (verdict) {
      // 需求验证给的是「🟢 GO」「🟡 观察」「放弃」三种；放弃没带图标，这里补上
      current.verdict = verdict[1].trim() === "放弃" ? "❌ 放弃" : verdict[1].trim();
      current.reason = verdict[2].trim();
    }
    const trend = line.match(/Trends\((codes|wiki)\):\s*(.+)$/);
    if (trend) current.trend = trend[2].trim();
    // 量级（相对自家锚点站）：报告里不显示它，读者无法分辨「零量词 rising」和「真需求」
    const mag = line.match(/量级:\s*(.+)$/);
    if (mag) current.magnitude = mag[1].trim().replace(/^近期约锚点\(([^)]+)\)的\s*/, "vs $1：");
    const sub = line.match(/子关键词:\s*(.+)$/);
    if (sub) current.sub = sub[1].trim().slice(0, 120);
  }
  return out;
}

/**
 * 拿去做需求验证的候选：强错配（🎣🎣）和成长期各占一半，成长期只要 CCU 800–60K
 * （太小撑不起站、太大 SERP 已锁死）。Trends 会限流，总数控制在 limit 以内。
 */
function shortlist(growth, mismatch, limit = 8) {
  const picked = new Map();
  const half = Math.ceil(limit / 2);
  for (const m of mismatch.filter((r) => r.flag === "🎣🎣").slice(0, half)) picked.set(m.id, m.name);
  for (const g of growth.filter((r) => r.ccu >= 800 && r.ccu <= 60_000)) {
    if (picked.size >= limit) break;
    picked.set(g.id, g.name);
  }
  return [...picked.values()].map(cleanRobloxName).filter(Boolean);
}

async function robloxLayer() {
  const [growthText, mismatchText] = await Promise.all([
    run("lib/roblox-growth-scan.mjs"),
    run("lib/roblox-yt-mismatch.mjs"),
  ]);
  const growth = parseGrowth(growthText);
  const mismatch = parseMismatch(mismatchText);
  const names = shortlist(growth, mismatch);
  const demand = names.length ? parseDemand(await run("lib/roblox-demand-scan.mjs", names)) : [];
  return { demand, growth, mismatch, errors: [growthText, mismatchText].filter((t) => t.startsWith("⚠️")) };
}

// ─── 读当天每日管线的报告 ─────────────────────────────────────────────────────

function readReport(kind) {
  const file = join(SHIP, `RADAR-${kind}-${today}.md`);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

/** 表格里以某些判决开头的行，原样带出（最多 n 行）。 */
function rowsStartingWith(md, marks, n = 8) {
  if (!md) return [];
  return md
    .split("\n")
    .filter((line) => marks.some((mark) => line.startsWith(`| ${mark}`)))
    .slice(0, n);
}

// ─── 今日总报告 ───────────────────────────────────────────────────────────────

function table(header, rows) {
  return rows.length ? [header, header.replace(/[^|]+/g, "---"), ...rows] : ["（今天没有）"];
}

async function daily() {
  const invest = readReport("INVEST");
  const playable = readReport("PLAYABLE");
  const meme = readReport("MEME");
  const roblox = args.includes("--skip-roblox") ? null : await robloxLayer();

  const steamTop = rowsStartingWith(invest, ["🟢", "🔔"]);
  const steamWatch = rowsStartingWith(invest, ["🟡"], 5);
  const playableTop = rowsStartingWith(playable, ["🟢", "🟡 待复核"]);
  const memeTop = rowsStartingWith(meme, ["🚨"]);
  const robloxGo = roblox?.demand.filter((d) => d.verdict.startsWith("🟢")) ?? [];
  // 已经验证为「放弃」的错配不进「最值得看」（视频多但没人搜攻略，做站也接不住流量）
  const strongMismatch =
    roblox?.mismatch.filter(
      (m) => m.flag === "🎣🎣" && !roblox.demand.some((d) => d.name === cleanRobloxName(m.name) && d.verdict.startsWith("❌")),
    ) ?? [];

  const headline = [
    ...robloxGo.map((d) => `- **Roblox** ${d.name}：${d.verdict}（${d.reason}）`),
    ...strongMismatch.map((m) => {
      const name = cleanRobloxName(m.name);
      const verified = roblox?.demand.find((d) => d.name === name);
      const demandNote = verified ? `；需求验证 ${verified.verdict}` : "；还没做需求验证";
      return `- **Roblox 错配** ${name}：本周 ${m.channels} 个频道在做视频，热度是在线人数的 ${m.ratio} 倍（Hole Fishing 模型${demandNote}）`;
    }),
    ...steamTop.map((r) => `- **Steam** ${r.split("|")[2]?.trim()}：${r.split("|")[1]?.trim()}（总分 ${r.split("|")[3]?.replace(/\*/g, "").trim()}）`),
    ...playableTop.map((r) => `- **可玩游戏** ${r.split("|")[2]?.trim()}：${r.split("|")[1]?.trim()}`),
    ...memeTop.map((r) => `- **梗** ${r.split("|")[2]?.replace(/\[([^\]]+)\]\([^)]*\)/, "$1").trim()}：刚冒头（${r.split("|")[3]?.trim()}）`),
  ];

  const lines = [
    `# 游戏雷达总报告 ${today}`,
    "",
    "> `game-name-radar/radar.mjs` · Roblox + Steam + 可玩游戏 + 梗，四条线一份报告 · 零搜索额度",
    "> 细节在各自的报告：RADAR-INVEST / RADAR-PLAYABLE / RADAR-MEME（同日期）",
    "",
    "## 今天最值得看",
    "",
    ...(headline.length ? headline : ["今天没有达到「值得投入」线的候选。"]),
    "",
    "## Roblox",
    "",
  ];
  if (!roblox) {
    lines.push("（本次用了 --skip-roblox，没跑 Roblox 层）", "");
  } else {
    if (roblox.errors.length) lines.push(...roblox.errors.map((e) => `> ${e}`), "");
    lines.push("**需求验证**（成长期 + 错配里挑的前几名；Trends 曲线 + 量级 + 攻略子词）：", "");
    lines.push(
      ...table(
        "| 判决 | 游戏 | Trends | 量级（vs 锚点） | 子关键词 |",
        roblox.demand.map((d) => `| ${d.verdict || "?"} | ${d.name} | ${d.trend} | ${d.magnitude || "-"} | ${d.sub} |`),
      ),
      "",
      "**YouTube 错配**（创作者跑得比玩家快）：",
      "",
      ...table(
        "| 信号 | 游戏 | 本周频道 | 热度÷在线 | 在线 |",
        roblox.mismatch.slice(0, 8).map((m) => `| ${m.flag} | ${m.name} | ${m.channels} | ${m.ratio} | ${m.ccu} |`),
      ),
      "",
      "**成长期 top 10**（增长比 = 当前在线 × 60 ÷ 日均访问；越高越是刚起量）：",
      "",
      ...table(
        "| 增长比 | 游戏 | 在线 | 上线天数 | 最近更新 |",
        roblox.growth.slice(0, 10).map((g) => `| ${g.growth}x | ${g.name} | ${g.ccu} | ${g.ageDays} 天 | ${g.updatedDaysAgo} 天前 |`),
      ),
      "",
    );
  }
  lines.push("## Steam（投入价值）", "");
  if (!invest) lines.push("（今天的 RADAR-INVEST 还没生成：每日管线 08:30 跑，可能没开机或还没跑完）", "");
  else lines.push(...table("| 判决 | 游戏 | 总分 | 需求 | 结构 | 窗口 | 广告 | 持续 |", [...steamTop, ...steamWatch]), "");
  lines.push("## 可玩游戏（HTML5 起量）", "");
  if (!playable) lines.push("（今天的 RADAR-PLAYABLE 还没生成）", "");
  else lines.push(...table("| 判决 | 游戏 | 热度 | 增长 | 同比 | 峰值 | 前 5 国 | 首见 | 域名 |", playableTop), "");
  lines.push("## 梗游戏", "");
  if (!meme) lines.push("（今天的 RADAR-MEME 还没生成）", "");
  else lines.push(...table("| 判决 | 梗 | 各市场可玩补全 | 例子 | 来源 | 首见 | 域名 |", memeTop), "");

  const out = join(SHIP, `RADAR-${today}.md`);
  writeFileSync(out, `${lines.join("\n")}\n`);
  console.log(`✓ ${out}`);
  console.log(headline.length ? headline.join("\n") : "今天没有达到「值得投入」线的候选。");
}

// ─── 单查：自动判平台 ─────────────────────────────────────────────────────────

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** 判平台用的查询偶尔会超时（代理抖一下就漏判），失败重试两次。 */
async function fetchJson(url, attempts = 3) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20_000) });
      if (res.ok) {
        return await res.json();
      }
    } catch {
      // 重试
    }
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  return null;
}

async function onRoblox(name) {
  const d = await fetchJson(
    `https://apis.roblox.com/search-api/omni-search?searchQuery=${encodeURIComponent(name)}&sessionId=radar&pageType=all`,
  );
  const games = (d?.searchResults ?? []).flatMap((g) => g.contents ?? []).filter((c) => c.contentType === "Game");
  // 只认名字对得上的：完全一致，或以查询词开头且有一定在线（防「Dressmaker」匹到 11 人在线的同名小游戏）
  const hit = games.find((g) => {
    const n = norm(cleanRobloxName(g.name ?? ""));
    return n === norm(name) || (n.startsWith(norm(name)) && (g.playerCount ?? 0) >= 300);
  });
  return hit ? { name: cleanRobloxName(hit.name), playing: hit.playerCount ?? 0, universeId: hit.universeId } : null;
}

async function onSteam(name) {
  const d = await fetchJson(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(name)}&cc=US&l=en`);
  const hit = (d?.items ?? []).find((i) => norm(i.name) === norm(name) || norm(i.name).startsWith(norm(name)));
  return hit ? { appId: hit.id, name: hit.name } : null;
}

async function check(names) {
  for (const name of names) {
    const [roblox, steam] = await Promise.all([onRoblox(name), onSteam(name)]);
    console.log(`\n════ ${name} ════`);
    console.log(
      `平台：${[roblox && `Roblox（${roblox.name}，在线 ${roblox.playing}）`, steam && `Steam（${steam.name}，appid ${steam.appId}）`].filter(Boolean).join(" + ") || "Roblox / Steam 都没有 → 按可玩游戏 / 梗查"}`,
    );
    if (roblox) {
      console.log("\n── Roblox 需求验证");
      console.log(await run("lib/roblox-demand-scan.mjs", [roblox.name]));
    }
    if (steam) {
      console.log("── Steam 工具闸门");
      console.log(await run("lib/steam-gate.mjs", [steam.name]));
      console.log("── Steam 投入价值");
      console.log(await run("lib/invest-score.mjs", [String(steam.appId), steam.name]));
    }
    if (!(roblox || steam)) {
      console.log("── 可玩游戏走势");
      console.log(await run("lib/playable-trend-watch.mjs", [name]));
      console.log("── 梗雷达（高 CPM 市场本地语言联想）");
      console.log(await run("lib/meme-game-watch.mjs", [name]));
    }
  }
}

const IS_MAIN = import.meta.url === `file://${process.argv[1]}` || Boolean(process.argv[1]?.endsWith("radar.mjs"));
if (IS_MAIN) {
  if (args[0] === "check") {
    const names = args.slice(1).filter((a) => !a.startsWith("--"));
    if (!names.length) {
      console.error('用法：node radar.mjs check "游戏名" ["游戏名2" ...]');
      process.exit(1);
    }
    await check(names);
  } else {
    await daily();
  }
}
