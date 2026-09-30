#!/usr/bin/env node
/**
 * invest-score.mjs — 「值不值得投入」评分（2026-09-30 加）
 *
 * 为什么需要：雷达原来只回答「有没有热度 / 有没有 wiki」，不回答「做了能不能靠广告赚钱」。
 * 自有站实测：点击/千 CCU 差 285 倍（dungeonlootr 174 vs commandanarmy 0.32），
 * 决定因素是「能拆成多少个独立排名页」+「窗口有没有被占」，不是游戏热度。
 *
 * 五个维度，各 0-20，满分 100。全部零成本源（Steam API / Google Suggest / RDAP / MediaWiki API），
 * 不花 SerpApi / Serper 额度：
 *   demand     需求   = Suggest 里的玩法长尾数（发售前后的 ps5/price/release date 不算）+ CCU 量级
 *   structure  结构   = Steam 标签（Life Sim/Crafting/RPG… = 实体多；Visual Novel/Walking Sim = 线性）+ 成就数
 *   window     窗口   = 品牌域名是否可买 + 品牌域名被抢注数 + wiki.gg/Fandom 体量
 *   adValue    广告价值 = 付费买断（成人 PC/主机玩家）> F2P；NSFW 标签 = AdSense 不可投，一票否决
 *   retention  持续性 = 当前 CCU / 记录到的峰值（发售 < 3 天给中性分，每轮扫描累积 ccuHistory）
 *
 * 判决：🟢 go ≥ 65 · 🟡 watch 45-64 · ❌ skip < 45；发售前的心愿单游戏另有 🔔 prelaunch（该抢域名预埋了）
 *
 * 用法：
 *   node lib/invest-score.mjs 1488490 "Nivalis Nights"     # appId + 名字
 *   node lib/invest-score.mjs --json 1488490 "Nivalis Nights"
 */
import { GENERIC_WORDS } from './steam-gate.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';

// 实体多 = 每个实体一页（鱼/配方/角色/职业/boss/装备）
const ENTITY_TAGS = new Set([
  'Life Sim', 'Farming Sim', 'Crafting', 'Survival', 'Open World Survival Craft', 'Base Building', 'Colony Sim',
  'Automation', 'Management', 'Resource Management', 'City Builder', 'RPG', 'Action RPG', 'JRPG', 'CRPG', 'MMORPG',
  'Roguelike', 'Roguelite', 'Action Roguelike', 'Deckbuilding', 'Card Battler', 'Loot', 'Looter Shooter',
  'Creature Collector', 'Pokémon', 'Fishing', 'Cooking', 'Dating Sim', 'Romance', 'Tower Defense', 'Metroidvania',
  'Souls-like', 'Collectathon', 'Idler', 'Trading', 'Hero Shooter', 'Monster Taming', 'Sandbox', 'Strategy', 'Tactical RPG',
]);
// 线性 / 短流程 = 攻略需求一次性，撑不起几十页
const LINEAR_TAGS = new Set([
  'Walking Simulator', 'Visual Novel', 'Interactive Fiction', 'Short', 'Puzzle', 'Platformer', 'Racing', 'Sports',
  'Rhythm', 'Arcade', 'Point & Click', 'Hidden Object', 'Choose Your Own Adventure',
]);
const NSFW_TAGS = new Set(['Sexual Content', 'Nudity', 'NSFW', 'Hentai', 'Mature']);
// 发售前后的元信息联想，不代表「玩的时候会搜」
const META_QUERY = /\b(release|date|price|cost|ps[45]|playstation|xbox|switch|steam|reddit|review|trailer|console|platform|demo|download|crack|requirements|metacritic|coop|co-op|multiplayer|how long|length|dlc|update|patch|mac|linux|deck|pc|mobile|android|ios|free|sale|discord|wiki|where to play|gameplay|twitter|news|leak|size|gb|refund|preorder|pre-order|edition|beta|early access|vs|like|worth it|ign|youtube|game|games|characters?|character creation|map)\b/i;
// 通用种子（不绑类型）；characters/map 只用来带出长尾，本身算元信息
const QUERY_SUFFIXES = ['', ' how to', ' how to get', ' where to', ' best', ' can you', ' characters', ' map', ' all', ' list'];
const DOMAIN_TLDS = ['com', 'net', 'wiki', 'xyz'];

async function getJson(url, opts = {}) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...opts.headers }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function getText(url, headers = {}) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(25_000) });
    return res.ok ? await res.text() : '';
  } catch {
    return '';
  }
}

export function appIdFromCandidate(candidate) {
  for (const s of candidate.sources || []) {
    const m = String(s.url || '').match(/store\.steampowered\.com\/app\/(\d+)/);
    if (m) return m[1];
  }
  return null;
}

export function domainSlug(game) {
  return game.toLowerCase().replace(/[™®©]/g, '').replace(/[^a-z0-9]/g, '');
}

/** 只保留「包含游戏名 + 不是元信息」的联想 = 玩家真在玩时才会搜的词 */
export function gameplayLongTail(game, suggestions) {
  const head = game.toLowerCase().replace(/[™®©]/g, '').trim().slice(0, 12);
  const out = new Set();
  for (const raw of suggestions) {
    const q = raw.toLowerCase().trim();
    if (!q.includes(head)) continue;
    const rest = q.replace(game.toLowerCase(), '').trim();
    if (!rest || META_QUERY.test(rest)) continue;
    out.add(q);
  }
  return [...out];
}

async function suggest(q) {
  const d = await getJson(`https://suggestqueries.google.com/complete/search?client=firefox&hl=en&gl=us&q=${encodeURIComponent(q)}`);
  return Array.isArray(d?.[1]) ? d[1] : [];
}

/** RDAP：404 = 未注册；200 = 已注册（带注册日期） */
async function rdap(domain) {
  try {
    const res = await fetch(`https://rdap.org/domain/${domain}`, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(20_000) });
    if (res.status === 404) return { domain, available: true };
    if (!res.ok) return { domain, available: null };
    const d = await res.json().catch(() => ({}));
    const reg = (d.events || []).find((e) => e.eventAction === 'registration')?.eventDate?.slice(0, 10) || null;
    return { domain, available: false, registered: reg };
  } catch {
    return { domain, available: null };
  }
}

/** wiki.gg / Fandom 探测。和 steam-gate 的 probeWikiDomains 不同：**网络失败要记下来**——
 *  本机 Fandom 常整个连不上（2026-09-30 实测 fetch failed），当成「没 wiki」会把老游戏误判成窗口大开（Scrap Mechanic 🟢 事故）。 */
async function probeWikis(game) {
  const slugs = [...new Set([domainSlug(game), game.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')])].filter((x) => x.length >= 3);
  const found = [];
  const failed = new Set();
  for (const slug of slugs) {
    for (const host of [`${slug}.wiki.gg`, `${slug}.fandom.com`]) {
      try {
        const res = await fetch(`https://${host}/api.php?action=query&meta=siteinfo&siprop=statistics&format=json`, {
          headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12_000),
        });
        const stats = res.ok ? (await res.json().catch(() => null))?.query?.statistics : null;
        if (stats && Number(stats.articles ?? 0) > 0) found.push(`${host}(${stats.articles}页)`);
      } catch {
        failed.add(host.split('.').slice(1).join('.'));
      }
      await sleep(250);
    }
  }
  return { found: [...new Set(found)], failed: [...failed] };
}

/** 网络层：只采事实，不打分 */
export async function gatherFacts(game, appId, prev = {}) {
  const facts = { game, appId, checkedAt: new Date().toISOString() };

  const details = (await getJson(`https://store.steampowered.com/api/appdetails?appids=${appId}&cc=us&l=en`))?.[appId]?.data;
  facts.released = details ? !details.release_date?.coming_soon : null;
  facts.releaseDate = details?.release_date?.date || '';
  facts.isFree = Boolean(details?.is_free);
  facts.priceUsd = details?.price_overview ? details.price_overview.initial / 100 : null;
  facts.genres = (details?.genres || []).map((g) => g.description);

  const html = await getText(`https://store.steampowered.com/app/${appId}/?l=english`, {
    Cookie: 'birthtime=0; wants_mature_content=1; lastagecheckage=1-0-1990',
  });
  const tagJson = html.match(/InitAppTagModal\(\s*\d+,\s*(\[[\s\S]*?\])\s*,/)?.[1];
  try { facts.tags = JSON.parse(tagJson).map((t) => t.name).slice(0, 20); } catch { facts.tags = []; }

  const ccu = (await getJson(`https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${appId}`))?.response;
  facts.ccu = ccu?.result === 1 ? ccu.player_count : null;
  const history = [...(prev.ccuHistory || [])];
  if (facts.ccu !== null) history.push({ t: facts.checkedAt.slice(0, 13), ccu: facts.ccu });
  facts.ccuHistory = history.slice(-60);

  const ach = await getJson(`https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=${appId}`);
  facts.achievements = ach?.achievementpercentages?.achievements?.length ?? null;

  const reviews = await getJson(`https://store.steampowered.com/appreviews/${appId}?json=1&language=all&purchase_type=all&num_per_page=0`);
  facts.reviews = reviews?.query_summary?.total_reviews ?? null;

  const all = [];
  for (const suffix of QUERY_SUFFIXES) {
    all.push(...(await suggest(`${game.toLowerCase()}${suffix}`)));
    await sleep(300);
  }
  facts.longTail = gameplayLongTail(game, all);

  const slug = domainSlug(game);
  facts.domains = [];
  for (const d of [...DOMAIN_TLDS.map((t) => `${slug}.${t}`), `${slug}wiki.com`, `${slug}guide.com`]) {
    facts.domains.push(await rdap(d));
    await sleep(200);
  }
  const wiki = await probeWikis(game.replace(/[™®©]/g, ''));
  facts.wikis = wiki.found;
  facts.wikiProbeFailed = wiki.failed;
  return facts;
}

function daysSince(dateStr, now) {
  const t = Date.parse(dateStr);
  return Number.isFinite(t) ? (now - t) / 86400000 : null;
}

/** 纯函数：事实 → 五维分数 + 判决（可测试） */
export function scoreInvest(facts, now = Date.now()) {
  const reasons = [];
  const tags = facts.tags || [];
  const dims = {};

  // ① 需求：玩法长尾 0-14 + CCU 量级 0-6
  const lt = facts.longTail?.length || 0;
  const ccuPeak = Math.max(0, ...(facts.ccuHistory || []).map((h) => h.ccu), facts.ccu || 0);
  const ccuPts = ccuPeak >= 20000 ? 6 : ccuPeak >= 5000 ? 5 : ccuPeak >= 1500 ? 4 : ccuPeak >= 500 ? 2 : 0;
  dims.demand = Math.min(20, Math.min(14, lt * 2) + ccuPts);
  reasons.push(`需求：玩法长尾 ${lt} 条${lt ? `（${facts.longTail.slice(0, 4).join(' / ')}）` : ''} · 峰值 CCU ${ccuPeak || '—'}`);

  // ② 结构：实体型标签越多越好，线性标签扣分；成就数兜底
  const entity = tags.filter((t) => ENTITY_TAGS.has(t));
  const linear = tags.filter((t) => LINEAR_TAGS.has(t));
  let structure = Math.min(14, entity.length * 3) - linear.length * 3;
  if ((facts.achievements || 0) >= 60) structure += 6;
  else if ((facts.achievements || 0) >= 30) structure += 3;
  dims.structure = Math.max(0, Math.min(20, structure));
  reasons.push(`结构：实体型标签 ${entity.slice(0, 5).join('/') || '无'}${linear.length ? ` · 线性标签 ${linear.join('/')}` : ''} · 成就 ${facts.achievements ?? '—'}`);

  // ③ 窗口：品牌域名 + 抢注 + wiki 体量
  const domains = facts.domains || [];
  const avail = (tld) => domains.find((d) => d.domain.endsWith(`.${tld}`) && !/(wiki|guide)\.com$/.test(d.domain))?.available;
  const squatted = domains.filter((d) => d.available === false).length;
  let window = avail('com') ? 10 : avail('net') || avail('wiki') ? 6 : avail('xyz') ? 3 : 0;
  window += Math.max(0, 6 - squatted * 2); // 品牌域名被抢得越多 = 越多人盯上了
  const wikiPages = (facts.wikis || []).map((w) => Number(w.match(/\((\d+)页\)/)?.[1] || 0));
  const maxWiki = wikiPages.length ? Math.max(...wikiPages) : 0;
  const probeFailed = facts.wikiProbeFailed || [];
  // 探测失败 = 未知，不给「没 wiki」的 +4
  window += maxWiki > 500 ? -4 : maxWiki > 100 ? 0 : probeFailed.length ? 0 : 4;
  // 品牌域名在发售前一年多就被注册 = 老 IP / 老生态（Scrap Mechanic 1.0 才 69 天，但游戏已存在十年）
  const release = Date.parse(facts.releaseDate);
  const oldest = Math.min(...domains.map((d) => Date.parse(d.registered || '')).filter(Number.isFinite));
  const legacy = Number.isFinite(release) && Number.isFinite(oldest) && release - oldest > 365 * 86400000;
  if (legacy) window -= 4;
  dims.window = Math.max(0, Math.min(20, window));
  const freeList = domains.filter((d) => d.available).map((d) => d.domain);
  reasons.push(`窗口：可买 ${freeList.join(' ') || '无'} · 已被注册 ${squatted}/${domains.length} · wiki ${facts.wikis?.join(' ') || '无'}${probeFailed.length ? `（${probeFailed.join('/')} 探测失败，按未知计）` : ''}${legacy ? ` · 品牌域名 ${new Date(oldest).toISOString().slice(0, 4)} 年就被注册（老生态）` : ''}`);

  // ④ 广告价值：付费买断 > F2P；NSFW 一票否决
  const nsfw = tags.filter((t) => NSFW_TAGS.has(t));
  const price = facts.priceUsd;
  dims.adValue = nsfw.length ? 0 : price >= 15 ? 18 : price >= 5 ? 14 : facts.isFree ? 10 : price > 0 ? 8 : 10;
  reasons.push(`广告价值：${facts.isFree ? 'F2P' : price ? `$${price}` : '价格未知'}${nsfw.length ? ` · ⛔ NSFW 标签 ${nsfw.join('/')}（AdSense 不可投）` : ''}`);

  // ⑤ 持续性：当前 / 峰值；发售 < 3 天或未发售给中性分
  const age = daysSince(facts.releaseDate, now);
  // 单个样本算不出衰减：至少 2 个样本、跨度 ≥ 20h（每天扫描累积）
  const hist = facts.ccuHistory || [];
  const spanH = hist.length >= 2 ? (Date.parse(`${hist.at(-1).t}:00Z`) - Date.parse(`${hist[0].t}:00Z`)) / 3600000 : 0;
  if (!facts.released || age === null || age < 3 || !ccuPeak || spanH < 20) {
    dims.retention = 10;
    reasons.push(`持续性：${facts.released ? `发售 ${age === null ? '?' : age.toFixed(0)} 天，CCU 样本 ${hist.length} 个，数据不足` : '未发售'}（中性分）`);
  } else {
    const ratio = (facts.ccu || 0) / ccuPeak;
    dims.retention = ratio >= 0.6 ? 20 : ratio >= 0.4 ? 14 : ratio >= 0.25 ? 8 : 3;
    reasons.push(`持续性：当前 ${facts.ccu} / 峰值 ${ccuPeak} = ${(ratio * 100).toFixed(0)}%（发售 ${age.toFixed(0)} 天）`);
  }

  const score = Object.values(dims).reduce((a, b) => a + b, 0);
  let verdict = score >= 65 ? 'go' : score >= 45 ? 'watch' : 'skip';
  const vetoes = [];
  if (nsfw.length) vetoes.push('NSFW');
  if (GENERIC_WORDS.test(facts.game)) vetoes.push('名字通用');
  if (vetoes.length) verdict = 'skip';
  // 窗口是闸门不是加分项：需求再真，位置被占了也轮不到你（Fields of Mistria：wiki.gg 2953 页）
  const capped = [];
  if (dims.window <= 5) capped.push(`窗口 ${dims.window} 分（位置已被占）`);
  if (maxWiki > 1000) capped.push(`wiki ${maxWiki} 页`);
  if (verdict === 'go' && capped.length) { verdict = 'watch'; reasons.push(`⚠️ 降为观察：${capped.join('、')}`); }
  // 发售前：需求还没长出来，但结构 + 广告价值 + 窗口都在 = 该抢域名预埋
  if (!facts.released && !vetoes.length && dims.structure >= 12 && dims.adValue >= 14 && dims.window >= 10) verdict = 'prelaunch';

  return { modelVersion: 1, score, verdict, vetoes, dims, reasons };
}

export const VERDICT_LABEL = { go: '🟢 值得投入', watch: '🟡 观察', skip: '❌ 放弃', prelaunch: '🔔 预埋（发售前抢位）' };

export async function investScore(game, appId, prev = {}) {
  const facts = await gatherFacts(game, appId, prev);
  return { ...scoreInvest(facts), facts, ccuHistory: facts.ccuHistory, checkedAt: facts.checkedAt };
}

/** 报告：给人读的 Markdown（scan.mjs 写到 Ship 根目录 RADAR-INVEST-<日期>.md） */
export function renderInvestReport(rows, date) {
  const order = { go: 0, prelaunch: 1, watch: 2, skip: 3 };
  rows = [...rows].sort((a, b) => order[a.verdict] - order[b.verdict] || b.score - a.score);
  const lines = [
    `# 投入价值雷达 — ${date}`, '',
    '> `game-name-radar/lib/invest-score.mjs` · 五维各 20 分：需求 / 结构 / 窗口 / 广告价值 / 持续性 · 零搜索额度',
    '> 🟢 ≥65 值得投入 · 🔔 发售前该抢位 · 🟡 45-64 观察 · ❌ <45', '',
    '| 判决 | 游戏 | 总分 | 需求 | 结构 | 窗口 | 广告 | 持续 |', '|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${VERDICT_LABEL[r.verdict]} | ${r.game} | **${r.score}** | ${r.dims.demand} | ${r.dims.structure} | ${r.dims.window} | ${r.dims.adValue} | ${r.dims.retention} |`),
    '',
  ];
  for (const r of rows.filter((x) => x.verdict !== 'skip')) {
    lines.push(`## ${VERDICT_LABEL[r.verdict]} ${r.game}（${r.score}）`, '', ...r.reasons.map((x) => `- ${x}`), '');
  }
  lines.push('⚠️ 广告价值只是代理指标（价格/受众），不是实测 RPM；🟢 的游戏动手前仍要按 AGENTS.md「建站前三问」抽样 SERP。');
  return lines.join('\n') + '\n';
}

// ── CLI ──
const IS_MAIN = Boolean(process.argv[1]?.endsWith('invest-score.mjs'));
if (IS_MAIN) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const [appId, ...nameParts] = args.filter((a) => !a.startsWith('--'));
  if (!appId || !nameParts.length) {
    console.error('用法: node lib/invest-score.mjs <steamAppId> "Game Name"');
    process.exit(1);
  }
  const r = await investScore(nameParts.join(' '), appId);
  if (json) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`\n▎${r.facts.game}  ${VERDICT_LABEL[r.verdict]}  ${r.score}/100`);
    for (const x of r.reasons) console.log(`  ${x}`);
  }
}
