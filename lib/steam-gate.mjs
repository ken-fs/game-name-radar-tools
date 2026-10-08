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
 *   ① 工具需求（autocomplete 查 calculator / database / planner / profit / tracker / tier list）
 *   ② wiki 覆盖（SERP + 直接探测 wiki.gg / Fandom 子域）
 *   ③ 名字辨识度（通用短语 → 直接淘汰，如 "How to Fish"）
 *
 * 判决（英文 code 供管线消费 / 中文供 CLI 阅读）：
 *   tool-opportunity      ✅ 工具机会（有工具需求 + wiki 未铺满）
 *   watch-wiki-mature     🟡 观察（工具需求真实，但 wiki 生态成熟）
 *   watch-weak-demand     🟡 观察（工具需求弱）
 *   reject-generic        ❌ 放弃（名字通用，Google 无法归因）
 *   reject-no-tool-demand ❌ 放弃（无工具需求）
 */
const QUERIES_TOOL = ['calculator', 'database', 'planner', 'profit', 'tracker', 'tier list'];
// 通用短语黑名单（这些名字 Google 无法归因到游戏）
export const GENERIC_WORDS = /^(how to|the |a |an )|^(fishing|farming|cooking|racing|fighting|survival|idle|clicker|simulator|tycoon)\b/i;
const WIKI_HOSTS = /(wiki\.gg|fandom\.com|wikipedia\.org|wikia\.com)/;
// 非游戏 wiki 噪音（wikipedia/archlinux 等会被 "wiki" 子串误匹配）
const NOISE_WIKI = /(wikipedia\.org|archlinux\.org|openstreetmap\.org|wikimedia\.org|wiki\.mozilla|wiktionary)/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function autocomplete(query) {
  try {
    const res = await fetch(
      `https://suggestqueries.google.com/complete/search?client=firefox&hl=en&q=${encodeURIComponent(query)}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12_000) },
    );
    const d = JSON.parse(await res.text());
    return Array.isArray(d?.[1]) ? d[1] : [];
  } catch {
    return [];
  }
}

async function serp(query) {
  // 第一通道 Serper（2,500 次免费；2026-10-08 前这里只接 SerpApi——100 次/月，没 key 就静默返空，
  // 导致 wiki 覆盖全靠 DDG 弱索引 → Yet Another Zombie Survivors 漏掉排名第 1 的 yetanotherzombie.wiki.gg）
  const serper = process.env.SERPER_API_KEY;
  if (serper) {
    try {
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': serper, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, num: 10, gl: 'us', hl: 'en' }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) {
        const d = await res.json();
        return { organic: (d.organic ?? []).map((x) => ({ pos: x.position, link: x.link, title: x.title })), via: 'serper' };
      }
    } catch { /* 落到 SerpApi */ }
  }
  const key = process.env.SERPAPI_API_KEY;
  if (!key) return { organic: [], via: null };
  try {
    const res = await fetch(
      `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&api_key=${key}&num=10&hl=en&gl=us`,
      { signal: AbortSignal.timeout(30_000) },
    );
    const d = await res.json();
    if (d.error) return { organic: [], error: String(d.error).slice(0, 60), via: 'serpapi' };
    return { organic: (d.organic_results ?? []).map((x) => ({ pos: x.position, link: x.link, title: x.title })), via: 'serpapi' };
  } catch {
    return { organic: [], via: 'serpapi' };
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

/** 抓单个 wiki 的 MediaWiki 页数（wiki.gg 的 HTML 页对非浏览器 UA 403，必须走 API）*/
async function wikiPages(host) {
  try {
    const res = await fetch(`https://${host}/api.php?action=query&meta=siteinfo&siprop=statistics&format=json`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const d = await res.json().catch(() => null);
    const n = Number(d?.query?.statistics?.articles ?? 0);
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** 直接探测 wiki.gg / Fandom 子域（SERP 漏检的兜底，2026-09-25 加）
 *  实例：rubinite 的 wiki 在 "rubinite wiki" SERP 里没进前 8，但 rubinite.wiki.gg 真实存在（26 页）。
 *  ⚠️ 必须用 MediaWiki API 探测——wiki.gg 的 HTML 页对非浏览器 UA 返回 403 Blocked。 */
export async function probeWikiDomains(game) {
  const slugs = [
    game.toLowerCase().replace(/[^a-z0-9]/g, ''),
    game.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
  ];
  const found = [];
  for (const slug of [...new Set(slugs)]) {
    if (slug.length < 3) continue;
    for (const host of [`${slug}.wiki.gg`, `${slug}.fandom.com`]) {
      const n = await wikiPages(host);
      if (n) found.push(`${host}(${n}页)`);
      await sleep(250);
    }
  }
  return [...new Set(found)];
}

const VERDICT_TEXT = {
  'tool-opportunity': '✅ 工具机会（有工具需求 + wiki 未铺满）',
  'watch-wiki-mature': '🟡 观察（工具需求真实，但 wiki 生态已成熟）',
  'watch-weak-demand': '🟡 观察（工具需求弱，仅 1 个长尾）',
  'reject-generic': '❌ 放弃（名字通用，Google 无法归因）',
  'reject-no-tool-demand': '❌ 放弃（无工具需求）',
};

/** 核心：对单个游戏跑三闸门。可被 scan.mjs 导入调用。 */
export async function steamGate(game) {
  const r = {
    game,
    toolHits: [],
    wikiHosts: [],
    nameGeneric: GENERIC_WORDS.test(game),
    verdict: '',
    note: [],
    checkedAt: new Date().toISOString(),
  };

  // ① 工具需求
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

  // ② wiki 覆盖：SERP（多查询）→ 对发现的 wiki 域名补抓页数 → 直接域名探测
  let serpVia = null;
  for (const q of [`${game} wiki`, `${game} bosses`, `${game} items`]) {
    let data = await serp(q);
    if (data.via) serpVia = data.via;
    if (!data.organic?.length) data = await ddgSerp(q);
    for (const item of (data.organic ?? []).slice(0, 8)) {
      try {
        const host = new URL(item.link).hostname.replace(/^www\./, '');
        if ((WIKI_HOSTS.test(host) || host.includes('wiki')) && !NOISE_WIKI.test(host)) r.wikiHosts.push(host);
      } catch { /* skip */ }
    }
    await sleep(700);
  }
  r.wikiHosts = [...new Set(r.wikiHosts)];
  // SERP 发现的 wiki 补上真实页数：无页数会被当「体量未知 = 按成熟计」，反而误伤新站点
  const bareHosts = r.wikiHosts.filter((h) => !h.includes('('));
  for (const host of bareHosts) {
    const n = await wikiPages(host);
    if (n) r.wikiHosts[r.wikiHosts.indexOf(host)] = `${host}(${n}页)`;
    else r.note.push(`${host} 页数未知（非 MediaWiki 或 API 不可达）`);
    await sleep(250);
  }
  const probed = await probeWikiDomains(game);
  for (const h of probed) {
    const bare = h.split('(')[0];
    const idx = r.wikiHosts.findIndex((x) => x.startsWith(bare));
    if (idx >= 0) r.wikiHosts[idx] = h; // 用带页数的版本覆盖裸域名（保留体量信息）
    else r.wikiHosts.push(h);
  }
  if (probed.length) r.note.push(`直接探测: ${probed.join(', ')}`);

  // ③ 判决（wiki 体量也是关键：26 页的 wiki 可超越，2000 页的不行）
  const toolDemand = r.toolHits.length;
  const wikiCovered = r.wikiHosts.length;
  // 从 "host(N页)" 解析最大 wiki 体量；SERP 发现的 host 无页数 → 视为未知（按成熟计）
  const sizes = r.wikiHosts.map((h) => {
    const m = h.match(/\((\d+)页\)/);
    return m ? Number(m[1]) : null;
  });
  const knownSizes = sizes.filter((n) => n !== null);
  const maxWikiPages = knownSizes.length ? Math.max(...knownSizes) : null;
  const totalWikiPages = knownSizes.reduce((a, b) => a + b, 0);
  const bigWiki = maxWikiPages !== null && maxWikiPages > 500;
  // 100+ 页的 wiki 通常已覆盖主要实体（实测 yetanotherzombie.wiki.gg 105 页 = 武器/角色齐全），可超越性低
  const fatWiki = maxWikiPages !== null && maxWikiPages > 100;
  const unknownWiki = sizes.includes(null);
  r.wikiPages = maxWikiPages;

  if (r.nameGeneric) {
    r.verdict = 'reject-generic';
    r.note.push('名字通用，Google 无法归因（参考 howtofish 反例）');
  } else if (toolDemand < 2) {
    r.verdict = toolDemand === 1 ? 'watch-weak-demand' : 'reject-no-tool-demand';
  } else if (bigWiki || fatWiki || wikiCovered >= 3 || (unknownWiki && wikiCovered >= 2)) {
    r.verdict = 'watch-wiki-mature';
    if (bigWiki) r.note.push(`最大 wiki ${maxWikiPages} 页（成熟，难超越）`);
    else if (fatWiki) r.note.push(`最大 wiki ${maxWikiPages} 页（体量已超过 100 页，难超越）；各 wiki 合计 ${totalWikiPages} 页`);
  } else {
    r.verdict = 'tool-opportunity';
    if (maxWikiPages !== null) r.note.push(`最大 wiki 仅 ${maxWikiPages} 页（可超越）`);
  }
  // 静默降级提醒：SERP 没通道时会漏检 wiki（2026-10-08 前这里没 key 就全空）
  if (!serpVia) r.note.push('⚠️ 无 SERPER/SERPAPI key，wiki 覆盖仅靠 DDG 弱索引，可能漏检');
  return r;
}

// ── CLI ──
const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
const games = args.filter((a) => !a.startsWith('--'));
const IS_MAIN =
  import.meta.url === `file://${process.argv[1]}` || Boolean(process.argv[1]?.endsWith('steam-gate.mjs'));

if (IS_MAIN) {
  if (games.length === 0) {
    console.error('用法: node lib/steam-gate.mjs "Game Name" ["Game 2" ...]');
    process.exit(1);
  }
  const results = [];
  for (const game of games) {
    const r = await steamGate(game);
    results.push(r);
    console.error(`  ${game} → ${VERDICT_TEXT[r.verdict] ?? r.verdict}`);
  }
  if (JSON_OUT) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log('\n═══ Steam 工具闸门 ═══\n');
    for (const r of results) {
      console.log(`▎${r.game}`);
      console.log(`  工具需求 (${r.toolHits.length}): ${r.toolHits.slice(0, 5).join(' | ') || '无'}`);
      console.log(`  wiki 覆盖 (${r.wikiHosts.length}${r.wikiPages !== null && r.wikiPages !== undefined ? `, 最大 ${r.wikiPages} 页` : ''}): ${r.wikiHosts.slice(0, 5).join(' | ') || '无'}`);
      console.log(`  判决: ${VERDICT_TEXT[r.verdict] ?? r.verdict}`);
      if (r.note.length) console.log(`  备注: ${r.note.join('；')}`);
      console.log();
    }
  }
}
