#!/usr/bin/env node
/**
 * steam-gate.mjs — Steam 游戏机会闸门（2026-09-25 加）
 *
 * 为什么需要：Steam 攻略路打不过 wiki.gg/Fandom 专业平台（实测 Fields of Mistria 有 4 个 wiki）。
 * 但 **wiki 不做交互工具** —— 「数据库 + 计算器」是空白区（实测 `fields of mistria gift calculator`
 * SERP 全空，而 stardewvalley.tools 这种工具站能排上去）。
 *
 * 用法：
 *   node lib/steam-gate.mjs "Fields of Mistria" "Coral Island" "Dinkum"
 *   node lib/steam-gate.mjs --json "Fields of Mistria"
 *
 * 三道闸门：
 *   ① 工具需求（autocomplete 查 calculator / database / planner / profit / tracker）
 *   ② wiki 覆盖（SERP 查 "<game> wiki"，看 wiki.gg / Fandom / 专用站是否已占位）
 *   ③ 名字辨识度（通用短语 → 直接淘汰，如 "How to Fish"）
 *
 * 判决：
 *   ✅ 工具机会   — 有工具需求 + wiki 未覆盖工具层
 *   🟡 观察       — 有工具需求但 wiki 已覆盖 / 或需求弱
 *   ❌ 放弃       — 无工具需求 / 名字通用 / 专用 wiki 已铺满
 */
const QUERIES_TOOL = ['calculator', 'database', 'planner', 'profit', 'tracker', 'tier list'];
// 通用短语黑名单（这些名字 Google 无法归因到游戏）
const GENERIC_WORDS = /^(how to|the |a |an )|^(fishing|farming|cooking|racing|fighting|survival|idle|clicker|simulator|tycoon)\b/i;
const WIKI_HOSTS = /(wiki\.gg|fandom\.com|wikipedia\.org|wikia\.com)/;

const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
const games = args.filter((a) => !a.startsWith('--'));
const IS_MAIN = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('steam-gate.mjs');

if (IS_MAIN && games.length === 0) {
  console.error('用法: node lib/steam-gate.mjs "Game Name" ["Game 2" ...]');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function autocomplete(query) {
  try {
    const res = await fetch(
      `https://suggestqueries.google.com/complete/search?client=firefox&hl=en&q=${encodeURIComponent(query)}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12_000) },
    );
    const text = await res.text();
    const d = JSON.parse(text);
    return Array.isArray(d?.[1]) ? d[1] : [];
  } catch {
    return [];
  }
}

async function serp(query) {
  const key = process.env.SERPAPI_API_KEY;
  if (!key) return { error: 'no key' };
  try {
    const res = await fetch(
      `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&api_key=${key}&num=10&hl=en&gl=us`,
      { signal: AbortSignal.timeout(30_000) },
    );
    const d = await res.json();
    if (d.error) return { error: String(d.error).slice(0, 60) };
    return { organic: (d.organic_results ?? []).map((x) => ({ pos: x.position, link: x.link, title: x.title })) };
  } catch (e) {
    return { error: String(e.message).slice(0, 60) };
  }
}

async function ddgSerp(query) {
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0' },
      signal: AbortSignal.timeout(20_000),
    });
    const html = await res.text();
    const out = [];
    const re = /class="result__a"[^>]*href="([^"]+)"[^>]*>/g;
    let m;
    while ((m = re.exec(html)) && out.length < 10) {
      let href = m[1];
      const u = href.match(/uddg=([^&]+)/);
      if (u) href = decodeURIComponent(u[1]);
      out.push({ pos: out.length + 1, link: href });
    }
    return { organic: out };
  } catch {
    return { organic: [] };
  }
}

export async function steamGate(game) {
  const r = { game, toolHits: [], wikiHosts: [], nameGeneric: GENERIC_WORDS.test(game), verdict: '', note: [], checkedAt: new Date().toISOString() };
  for (const suffix of QUERIES_TOOL) {
    const hits = await autocomplete(`${game} ${suffix}`);
    for (const h of hits) {
      const hl = h.toLowerCase();
      if (hl.includes(game.toLowerCase().slice(0, 12)) && /calculator|database|planner|profit|tracker|tier/.test(hl)) {
        if (!r.toolHits.includes(h)) r.toolHits.push(h);
      }
    }
    await sleep(300);
  }
  let serpData = await serp(`${game} wiki`);
  if (!serpData.organic?.length) serpData = await ddgSerp(`${game} wiki`);
  for (const item of (serpData.organic ?? []).slice(0, 8)) {
    try {
      const host = new URL(item.link).hostname.replace(/^www\./, '');
      if (WIKI_HOSTS.test(host) || host.includes('wiki')) r.wikiHosts.push(host);
    } catch { /* skip */ }
  }
  r.wikiHosts = [...new Set(r.wikiHosts)];
  const toolDemand = r.toolHits.length;
  const wikiCovered = r.wikiHosts.length;
  if (r.nameGeneric) { r.verdict = 'reject-generic'; r.note.push('名字通用，Google 无法归因（参考 howtofish 反例）'); }
  else if (toolDemand >= 2 && wikiCovered <= 1) r.verdict = 'tool-opportunity';
  else if (toolDemand >= 2 && wikiCovered >= 2) r.verdict = 'watch-wiki-mature';
  else if (toolDemand === 1) r.verdict = 'watch-weak-demand';
  else r.verdict = 'reject-no-tool-demand';
  return r;
}

const results = [];
if (IS_MAIN) for (const game of games) {
  const r = { game, toolHits: [], wikiHosts: [], nameGeneric: GENERIC_WORDS.test(game), verdict: '', note: [] };

  // ① 工具需求：autocomplete 扫 6 个后缀
  for (const suffix of QUERIES_TOOL) {
    const hits = await autocomplete(`${game} ${suffix}`);
    for (const h of hits) {
      const hl = h.toLowerCase();
      if (hl.includes(game.toLowerCase().slice(0, 12)) && /calculator|database|planner|profit|tracker|tier/.test(hl)) {
        if (!r.toolHits.includes(h)) r.toolHits.push(h);
      }
    }
    await sleep(350);
  }

  // ② wiki 覆盖：SerpApi → DDG 兜底
  let serpData = await serp(`${game} wiki`);
  if (!serpData.organic?.length) serpData = await ddgSerp(`${game} wiki`);
  for (const item of (serpData.organic ?? []).slice(0, 8)) {
    try {
      const host = new URL(item.link).hostname.replace(/^www\./, '');
      if (WIKI_HOSTS.test(host) || host.includes('wiki')) r.wikiHosts.push(host);
    } catch { /* skip */ }
  }
  r.wikiHosts = [...new Set(r.wikiHosts)];
  await sleep(800);

  // ③ 判决
  const toolDemand = r.toolHits.length;
  const wikiCovered = r.wikiHosts.length;
  if (r.nameGeneric) {
    r.verdict = '❌ 放弃（名字通用，Google 无法归因）';
    r.note.push('参考 howtofish 的反例');
  } else if (toolDemand >= 2 && wikiCovered <= 1) {
    r.verdict = '✅ 工具机会（有工具需求 + wiki 未铺满）';
  } else if (toolDemand >= 2 && wikiCovered >= 2) {
    r.verdict = '🟡 观察（工具需求真实，但 wiki 生态已成熟）';
  } else if (toolDemand === 1) {
    r.verdict = '🟡 观察（工具需求弱，仅 1 个长尾）';
  } else {
    r.verdict = '❌ 放弃（无工具需求）';
  }
  results.push(r);
  console.error(`  ${game} → ${r.verdict}`);
}

if (!IS_MAIN) { /* 模块导入：不输出 */ }
else if (JSON_OUT) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log('\n═══ Steam 工具闸门 ═══\n');
  for (const r of results) {
    console.log(`▎${r.game}`);
    console.log(`  工具需求 (${r.toolHits.length}): ${r.toolHits.slice(0, 5).join(' | ') || '无'}`);
    console.log(`  wiki 覆盖 (${r.wikiHosts.length}): ${r.wikiHosts.slice(0, 5).join(' | ') || '无'}`);
    console.log(`  判决: ${r.verdict}`);
    if (r.note.length) console.log(`  备注: ${r.note.join('；')}`);
    console.log();
  }
}
