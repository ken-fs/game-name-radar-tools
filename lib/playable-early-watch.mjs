#!/usr/bin/env node
/**
 * playable-early-watch.mjs — 早期 H5 / 每日小游戏发现（不依赖 Poki / Crazy Games / unblocked 联想）
 *
 * 门户雷达（playable-trend-watch）要等 Google Suggest + Trends 相对 Monkey Mart 成型才报。
 * All-the-Dles 周热、X 上先爆的每日游戏（Tree Appreciator、Gazillion、Plain）在那之前进不来。
 * 这一路只负责把它们送进早报，并打上 early / social。Trends 仍弱也不淘汰，也绝不升 🟢。
 * 门户词的 Monkey Mart 门槛仍只在 judge() 里。
 *
 * 维度（对齐同伴扫描的 S/M/N/L/C；C 在合成时取反）：
 *   S 社交尖峰。免费路径只有 Reddit 公开搜索 + DuckDuckGo 结果里的媒体/社交域名。
 *     没有独立信号时，目录名次只能把 S 封顶在 4.5（目录热度 ≠ 社交尖峰）。完全没测到则 S 不进平均。
 *   M 动量。周热名次为主；7d/30d 短窗只加分，不加 Monkey Mart 淘汰线。
 *   N 新鲜度。上线越近只加一点分，几个月以上落到大约 3.5。年龄不是淘汰线：
 *     周热、趋势还在抬、或答案巢还空的词，不会因为超过两三周就被丢掉。
 *     Size It Up 这种上线已久、答案站已经挤满的，输在 C（赛道满），不输在天数。
 *   L 可嵌性。只描述 iframe：无 XFO / 无 frame-ancestors ≈ 8.5；DENY 或 frame-ancestors none ≈ 5。
 *     开源部署不抬 L。
 *   C 拥挤（越高越挤）。同车道、门户域名、大品类、答案站成片。合成用 10−C。
 * 进探测名单按动量和赛道空位排：周热名次、车道里有没有一堆同类、趋势斜率、
 * 还能不能嵌或开源自托管。上线日只打破并列，不单独决定去留。
 *   综合 = mean(S, M, N, L, 10−C)，缺测的维度不进平均。同伴样本 Tree Appreciator
 *   （6.5, 7.5, 8.5, 8, 2）= 7.70。这是工作公式，不是把对方每一分都拟合死。
 *
 * 变现路径是三条，和判决分开写（都不自动变成 🟢）：
 *   1. 嵌入路径 — 响应头允许时「可试 iframe」。头只说明浏览器让不让嵌，不等于作者授权。
 *   2. 内容路径 — XFO / CSP 把嵌入挡住时改走答案 / 归档页（不搬官方题库）。
 *   3. 开源部署 — 玩法页或 GitHub 上有公开仓库时写出 URL、许可证、像不像静态页可自托管。
 *      有许可证且像静态页时优先标出来，通常好过干等嵌入授权。
 *
 *   node lib/playable-early-watch.mjs
 *   node lib/playable-trend-watch.mjs --early
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import googleTrends from './google-trends.mjs';
import { deriveGameName, parseRemoteDocument } from './scanner.mjs';
import { parseDuckResults } from './seo-verifier.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultStatePath = path.join(root, 'data', 'playable-early-state.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';
const ANCHOR = 'monkey mart';
const DAY = 864e5;

/** 门户雷达共用。比原来的名单多了宝可梦变体和常见大厂，避免 Poké Jam 这类漏网。 */
export const BIG_IP = /\b(halo|minecraft|pokemon|pok[eé]mon|pok[eé][\s-]?(?:dex|jam|dle|doku)|pikachu|mario|zelda|sonic|fortnite|roblox|gta|among us|call of duty|cod|fnaf|five nights|undertale|subway surfers|temple run|geometry dash|angry birds|tetris|pac-?man|plants vs zombies|toca boca|spongebob|disney|marvel|nintendo|xbox|playstation|genshin|league of legends|valorant|overwatch|harry potter|star wars|animal crossing|smash bros)\b/i;
const NYT_EXACT = /^(wordle|connections|spelling bee|strands)(?:\b|:)/i;
const PERMISSIVE = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'Zlib', '0BSD', 'Unlicense', 'CC0-1.0', 'BSL-1.0', 'MPL-2.0']);
const COPYLEFT = new Set(['GPL-2.0', 'GPL-2.0-only', 'GPL-2.0-or-later', 'GPL-3.0', 'GPL-3.0-only', 'GPL-3.0-or-later', 'AGPL-3.0', 'AGPL-3.0-only', 'LGPL-2.1', 'LGPL-3.0']);
const AGG_HOST = /(^|\.)(poki\.com|crazygames\.com|y8\.com|lagged\.com|gamepix\.com|miniplay\.com|silvergames\.com)$/i;
const SHARED_TREND_HOST = /(itch\.io|newgrounds\.com|github\.com|poki\.com|crazygames\.com|y8\.com|lagged\.com|gamepix\.com|britannica\.com|wikipedia\.org|youtube\.com|reddit\.com)$/i;
const MEDIA_HOST = /(dexerto\.com|polygon\.com|kotaku\.com|pcgamer\.com|rockpapershotgun\.com|gamesradar\.com|eurogamer\.|ign\.com|theverge\.com)/i;
const SOCIAL_HOST = /(reddit\.com|^x\.com$|twitter\.com|youtube\.com|tiktok\.com|bsky\.app)/i;
const SKIP_GH_OWNERS = new Set(['topics', 'features', 'site', 'settings', 'orgs', 'about', 'sponsors', 'marketplace', 'login', 'signup', 'explore', 'apps', 'collections', 'pulls', 'issues']);
const LANE_CROWD = { rarity: 2.5, nba: 2, word: 2, geo: 1.5, history: 0.5, estimate: 1, other: 0 };
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

export const EARLY_LABEL = {
  early: '🟡 早期/社交',
  'early-watch': '🟡 早期观察',
  'early-weak': '⚪ 早期弱',
  'skip-ip': '❌ 早期IP',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decode(value = '') {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function attr(tag, name) {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'))?.[1] || '';
}

function cell(value) {
  return String(value ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
}

export function parseHumanDate(text = '') {
  const m = String(text).match(/([A-Za-z]{3,9})\s+(\d{1,2}),\s+(\d{4})/);
  if (!m) return '';
  const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (month == null) return '';
  return new Date(Date.UTC(Number(m[3]), month, Number(m[2]))).toISOString().slice(0, 10);
}

export function compositeSMNLC({ S, M, N, L, C } = {}) {
  const parts = [S, M, N, L, C == null ? null : 10 - C].filter((v) => v != null && Number.isFinite(Number(v))).map(Number);
  if (!parts.length) return null;
  return +(parts.reduce((a, b) => a + b, 0) / parts.length).toFixed(2);
}

export function ipRisk(name = '', blurb = '') {
  const nameHit = String(name).match(BIG_IP) || String(name).match(NYT_EXACT);
  const blurbHit = String(blurb).match(BIG_IP);
  const hit = nameHit || blurbHit;
  if (!hit) return { risk: false, why: '' };
  return { risk: true, why: hit[0] };
}

export function tokenRisk(name = '', blurb = '') {
  return `${name} ${blurb}`.match(/\$[A-Z]{2,8}\b|\btoken\b/i)?.[0] || '';
}

export function parseEmbedPolicy({ xFrameOptions = '', contentSecurityPolicy = '' } = {}) {
  const xfo = String(xFrameOptions || '').split(',')[0].trim().toUpperCase();
  const faRaw = String(contentSecurityPolicy || '').match(/frame-ancestors\s+([^;]+)/i)?.[1]?.trim() || '';
  const faTokens = faRaw.toLowerCase().split(/\s+/).filter(Boolean);
  const faNone = faTokens.some((t) => t === "'none'" || t === 'none');
  const faSelfOnly = faTokens.length > 0 && faTokens.every((t) => t === "'self'" || t === 'self');
  const faAllowOther = faTokens.some((t) => !["'self'", 'self', "'none'", 'none'].includes(t));
  let deny = false;
  let linkability = 8.5;
  let note = '无 XFO，可试 iframe';
  if (!xfo && !faRaw) {
    deny = false;
    linkability = 8.5;
    note = '无 XFO，可试 iframe';
  } else if (xfo === 'DENY' || faNone) {
    deny = true;
    linkability = 5;
    note = [xfo === 'DENY' ? 'XFO DENY' : '', faNone ? 'frame-ancestors none' : ''].filter(Boolean).join(' + ');
  } else if (xfo === 'SAMEORIGIN' || faSelfOnly) {
    deny = true;
    linkability = 5;
    note = xfo === 'SAMEORIGIN' ? 'XFO SAMEORIGIN' : 'frame-ancestors self';
  } else if (faAllowOther) {
    deny = false;
    linkability = 6.5;
    note = 'frame-ancestors 白名单';
  } else if (xfo) {
    deny = true;
    linkability = 5.5;
    note = `XFO ${xfo}`;
  }
  return { xfo: xfo || 'none', frameAncestors: faRaw || 'none', deny, linkability, note, error: false };
}

export function embedPath(embed = {}) {
  if (embed.itchProject) return { open: false, label: '另核运行时', detail: embed.note || 'itch 项目页不能直接当 iframe' };
  if (embed.error || embed.deny == null) {
    const why = String(embed.note || '嵌入未测').replace(/^嵌入探测失败：/, '');
    return { open: false, label: `未测·${why}`.slice(0, 42), detail: embed.note || '嵌入未测' };
  }
  if (!embed.deny) return { open: true, label: '可试 iframe', detail: embed.note || '无 XFO' };
  return { open: false, label: `不可嵌·${embed.note || 'XFO/CSP'}`, detail: embed.note || '' };
}

export function contentPath(embed = {}) {
  if (embed.itchProject) return { role: 'fallback', label: '备选·答案/归档', note: 'itch 先找 HTML5 运行时或源码' };
  if (embed.error || embed.deny == null) return { role: 'unknown', label: '未测', note: '嵌入未测，内容页仍可作备选' };
  if (embed.deny) return { role: 'primary', label: '主路径·答案/归档', note: '嵌入被拒，改走答案/归档（不搬官方题库）' };
  return { role: 'fallback', label: '备选·答案/归档', note: 'iframe 可试时，内容页仍可做攻略/归档' };
}

export function hintSpdx(text = '') {
  const t = String(text);
  if (/apache\s+license\s+2\.0|apache-2\.0/i.test(t)) return 'Apache-2.0';
  if (/mit license|licensed under the mit/i.test(t)) return 'MIT';
  if (/gpl-3\.0|gnu general public license v?3/i.test(t)) return 'GPL-3.0';
  if (/bsd-3-clause/i.test(t)) return 'BSD-3-Clause';
  if (/cc0|creative commons zero/i.test(t)) return 'CC0-1.0';
  return '';
}

function looksStatic({ language = '', description = '', topics = [], rootFiles = [], pageHints = '' } = {}) {
  const files = rootFiles.join(' ');
  if (/\.html?(\b|$)/i.test(files)) return true;
  // 官方页本身是 HTML，不能把一个 Go / Python 仓库说成能静态部署。
  if (/^(go|python|c|c\+\+|rust|java|c#|ruby|swift|kotlin|objective-c)$/i.test(language)) return false;
  const blob = `${language} ${description} ${topics.join(' ')} ${pageHints}`.toLowerCase();
  const webStack = /html|javascript|typescript|phaser|three\.?js|webgl|canvas|browser/.test(blob);
  const pageIsHtmlGame = /<html[\s>]/i.test(pageHints) && /three\.?js|phaser|<canvas|type=["']module["']/i.test(pageHints);
  return pageIsHtmlGame || (webStack && /html|javascript|typescript/i.test(language || '') && /game|puzzle|daily|browser|phaser|three/.test(blob));
}

export function assessOpenSource(info = {}) {
  if (info.status === 'unmeasured') {
    const note = info.note || '未查';
    return { found: false, deployable: false, status: 'unmeasured', license: '', repoUrl: info.repoUrl || '', label: note, note, path: '未查' };
  }
  if (!info.repoUrl) {
    return { found: false, deployable: false, status: 'none', license: '', repoUrl: '', label: '无公开仓库', note: '页面和 GitHub 搜索都没看到公开仓库', path: '无公开仓库' };
  }
  const license = info.license || hintSpdx(info.pageHints || '');
  const licenseFromPage = !info.license && Boolean(license);
  const permissive = PERMISSIVE.has(license);
  const copyleft = COPYLEFT.has(license) || /^GPL|^AGPL|^LGPL/.test(license);
  const staticPage = looksStatic(info);
  let deployable = false;
  let note = '';
  if (!license) note = '有仓库但许可证不明，先别当可部署';
  else if (permissive && staticPage) {
    deployable = true;
    note = `${license} · 像静态/浏览器页，可自托管${licenseFromPage ? '（许可证来自页面文字）' : ''}`;
  } else if (permissive) note = `${license} · 有许可证，但是否能直接当静态页还要看构建（${info.language || '语言未知'}）`;
  else if (copyleft && staticPage) {
    deployable = true;
    note = `${license} · 可部署，需遵守 copyleft`;
  } else if (copyleft) note = `${license} · copyleft，且不像现成静态页`;
  else note = `${license} · 许可证未纳入常见开源清单`;
  const repo = String(info.repoUrl).replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '');
  const bit = deployable ? `${license} 可静态自托管` : note;
  const label = `${deployable ? '优先 ' : ''}[${repo}](${info.repoUrl}) ${bit}`;
  return { found: true, deployable, status: 'found', license, repoUrl: info.repoUrl, label, note, path: deployable ? '可自托管' : '仓库在，先别直接部署' };
}

export function monetizationPaths({ embed = {}, oss = null } = {}) {
  const source = oss || assessOpenSource({});
  return { embed: embedPath(embed), content: contentPath(embed), oss: source };
}

export function extractRepoUrls(html = '') {
  const urls = [];
  const seen = new Set();
  const re = /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/gi;
  for (const match of String(html).matchAll(re)) {
    const owner = match[1];
    const repo = match[2].replace(/\.git$/, '');
    if (SKIP_GH_OWNERS.has(owner.toLowerCase())) continue;
    const url = `https://github.com/${owner}/${repo}`;
    if (seen.has(url.toLowerCase())) continue;
    seen.add(url.toLowerCase());
    urls.push(url);
  }
  return urls;
}

export function parseGithubRepo(url = '') {
  const m = String(url).match(/github\.com\/([^/]+)\/([^/#?]+)/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/, '') };
}

function normName(name = '') {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function chooseLinkedRepo(urls = [], { slug = '', name = '' } = {}) {
  if (!urls.length) return '';
  const norm = normName(name);
  const slugNorm = normName(slug);
  const ranked = [...urls].sort((a, b) => score(b) - score(a));
  return ranked[0];
  function score(url) {
    const pathNorm = normName(url);
    let s = 0;
    if (slugNorm && pathNorm.includes(slugNorm)) s += 3;
    if (norm && pathNorm.includes(norm)) s += 3;
    return s;
  }
}

function mentionsName(field = '', norm = '') {
  const raw = String(field).toLowerCase();
  if (!norm) return false;
  if (raw.replace(/[^a-z0-9]+/g, '') === norm) return true;
  return new RegExp(`(?:^|[^a-z0-9])${norm}(?:[^a-z0-9]|$)`).test(raw);
}

function looksLikeGameRepo(item = {}) {
  const blob = `${item.description || ''} ${(item.topics || []).join(' ')}`.toLowerCase();
  return /game|html|phaser|daily|puzzle|browser|three\.?js|canvas|wordle|\bdle\b/.test(blob);
}

export function pickSearchRepo(payload = {}, name = '', { playHost = '', now = Date.now() } = {}) {
  const norm = normName(name);
  if (norm.length < 4) return null;
  const generic = !String(name).includes(' ') && norm.length < 8;
  const host = String(playHost || '').toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const item of payload.items || []) {
    // 搜索命中必须是这个名字本身，不能是 Gazillionaire 这种更长的别的游戏。
    // 还要是近 120 天的仓库，或主页 / 简介指向玩法域名。页面上的 GitHub 链接不走这里。
    if (!mentionsName(item.name, norm) && !mentionsName(item.full_name, norm)) continue;
    if (!looksLikeGameRepo(item)) continue;
    const created = Date.parse(item.created_at || '');
    const fresh = Number.isFinite(created) && now - created < 120 * DAY;
    const blob = `${item.description || ''} ${item.homepage || ''}`.toLowerCase();
    const hostHit = host && blob.includes(host);
    if (!fresh && !hostHit) continue;
    const repoName = normName(item.name || '');
    let score = repoName === norm ? 5 : 3;
    if (hostHit) score += 3;
    if (String(item.description || '').toLowerCase().includes(String(name).toLowerCase())) score += 2;
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  const min = generic ? 5 : 3;
  if (!best || bestScore < min) return null;
  return best;
}

export function detectLane(name = '', blurb = '', cats = '') {
  const t = `${name} ${blurb} ${cats}`.toLowerCase();
  if (/\bnba\b|basketball|hoops/.test(t)) return 'nba';
  if (/rarer|rarity|rare answer|fewer people|fewest/.test(t)) return 'rarity';
  if (/pin a country|geograph|map quiz|country/.test(t) && /daily|map|pin|geo/.test(t)) return 'geo';
  if (/\bwordle\b|guess the word|spelling/.test(t)) return 'word';
  if (/year range|guess the year|history/.test(t)) return 'history';
  if (/closest|estimate|scale|target number/.test(t)) return 'estimate';
  return 'other';
}

export function scoreCompetition({ lane = 'other', peers = [], playUrl = '', aggregatorHits = 0, answerNests = null } = {}) {
  let c = 2;
  const notes = [];
  const same = lane === 'other' ? [] : peers.filter((p) => p.lane === lane);
  if (same.length) {
    c += Math.min(3, same.length * 0.8);
    notes.push(`同车道：${same.map((p) => p.name).slice(0, 3).join('、')}`);
  }
  let host = '';
  try { host = new URL(playUrl).hostname.replace(/^www\./, ''); } catch { /* 无玩法 URL */ }
  if (AGG_HOST.test(host) || aggregatorHits > 0) {
    c += 2;
    notes.push(AGG_HOST.test(host) ? `玩法页在门户（${host}）` : '搜索结果里已有门户页');
  } else if (host) notes.push('玩法页不在 Poki / CrazyGames / Y8');
  if (LANE_CROWD[lane]) {
    c += LANE_CROWD[lane];
    notes.push(`车道 ${lane}`);
  }
  // 答案站成片 = 赛道已被内容站占满（Size It Up 一类）。这是拥挤，不是因为游戏上线久。
  if (answerNests == null) notes.push('答案巢未测');
  else if (answerNests >= 4) {
    c += 4.5;
    notes.push(`答案站已挤满（${answerNests} 家）`);
  } else if (answerNests >= 2) {
    c += 2;
    notes.push(`答案站 ${answerNests} 家`);
  } else notes.push('答案巢少');
  c = Math.min(10, Math.round(c * 10) / 10);
  if (!notes.length) notes.push('目录内未见明显同车道扎堆');
  return { c, lane, answerNests, notes };
}

export function scoreSocial({ social = {}, weeklyRank = null } = {}) {
  const measured = Boolean(social.measured)
    || social.likes != null
    || social.impressions != null
    || social.redditPosts7d != null
    || social.mediaMentions != null;
  if (!measured) return { score: null, note: '社交未测' };
  const likes = Number(social.likes) || 0;
  const impressions = Number(social.impressions) || 0;
  const bookmarks = Number(social.bookmarks) || 0;
  const reddit = Number(social.redditPosts7d) || 0;
  const media = Number(social.mediaMentions) || 0;
  const yt = Number(social.youtubeVideos7d) || 0;
  let s = 2;
  if (likes >= 1200 || impressions >= 100000 || bookmarks >= 500) s = 8.5;
  else if (likes >= 700 || impressions >= 40000) s = 7.5;
  else if (likes >= 300 || impressions >= 15000) s = 6.5;
  else if (likes >= 80) s = 5.5;
  if (reddit >= 200) s = Math.max(s, 9);
  else if (reddit >= 50) s = Math.max(s, 7);
  else if (reddit >= 10) s = Math.max(s, 5.5);
  else if (reddit >= 1) s = Math.max(s, 4);
  if (media >= 2) s = Math.max(s, 8);
  else if (media >= 1) s = Math.max(s, 6.5);
  if (yt >= 4) s = Math.max(s, 6.5);
  else if (yt >= 1) s = Math.max(s, 4.5);
  const independent = likes + impressions + bookmarks + reddit + media + yt;
  if (!independent) {
    const floor = weeklyRank && weeklyRank <= 3 ? 4 : weeklyRank && weeklyRank <= 10 ? 3.5 : 2.5;
    s = Math.min(4.5, floor);
  }
  return {
    score: +Math.min(10, s).toFixed(1),
    note: independent ? '有独立社交/媒体代理' : '仅目录热度，社交尖峰未形成',
  };
}

export function scoreMomentum({ weeklyRank = null, trends7 = null, trends30 = null, lists = [] } = {}) {
  const inNew = lists.includes('newly-added') || lists.includes('new-60d');
  let m = inNew ? 5.5 : 4;
  if (weeklyRank) {
    if (weeklyRank <= 3) m = 7.5;
    else if (weeklyRank <= 7) m = 7;
    else if (weeklyRank <= 12) m = 6;
  }
  if (trends7 != null && Number.isFinite(Number(trends7))) {
    const t7 = Number(trends7);
    const t30 = Number(trends30);
    if (t7 >= 20) m += 1.5;
    else if (t7 >= 5) m += 1;
    else if (t7 >= 1 && Number.isFinite(t30) && t7 > t30) m += 0.5;
  }
  return +Math.min(10, m).toFixed(1);
}

export function scoreNovelty({ launchedAt = '', lists = [] } = {}, now = Date.now()) {
  // 雷达自己的 firstSeen 不是上线日。没有目录日期时，不把「今天第一次扫到」当成刚发布。
  // N 只是加分：再老也停在 3.5，调用方不能靠天数把周热 / 还在涨 / 赛道还空的词扔掉。
  const inNew = lists.includes('newly-added') || lists.includes('new-60d');
  const stamp = Date.parse(launchedAt || '');
  if (!stamp) return { score: inNew ? 7.5 : 4, days: null };
  const days = Math.max(0, (now - stamp) / DAY);
  let n = 3.5;
  if (days <= 7) n = 9;
  else if (days <= 14) n = 8;
  else if (days <= 21) n = 7.5;
  else if (days <= 45) n = 5.5;
  else if (days <= 90) n = 4.5;
  return { score: n, days: Math.round(days) };
}

export function scoreEarly(input = {}, now = Date.now()) {
  const ip = ipRisk(input.name, input.blurb || '');
  const social = scoreSocial(input);
  const momentum = scoreMomentum(input);
  const novelty = scoreNovelty(input, now);
  const embed = input.embed || { linkability: 6, deny: null, error: true, note: '未测' };
  const oss = input.oss || assessOpenSource({});
  const paths = monetizationPaths({ embed, oss });
  let c = input.competition?.c ?? 3;
  const token = tokenRisk(input.name, input.blurb || '');
  if (token) c = Math.min(10, Math.round((c + 1) * 10) / 10);
  const L = Number.isFinite(embed.linkability) ? embed.linkability : 6;
  const composite = compositeSMNLC({ S: social.score, M: momentum, N: novelty.score, L, C: c });
  let verdict = 'early-weak';
  if (ip.risk) verdict = 'skip-ip';
  else if (composite >= 6.2 || (input.weeklyRank && input.weeklyRank <= 10 && composite >= 5.4)) verdict = 'early';
  else if (composite != null && composite >= 5) verdict = 'early-watch';
  return {
    dims: { S: social.score, M: momentum, N: novelty.score, L, C: c },
    composite,
    verdict,
    label: EARLY_LABEL[verdict],
    tag: 'early / social',
    paths,
    social,
    momentum,
    novelty,
    ip,
    token,
    competition: { ...(input.competition || {}), c },
  };
}

/** 独立域名用主机名做短窗（Plain → playplain.app），避免普通词把 Trends 打满。门户 / itch / Newgrounds 仍用游戏名。 */
export function trendsQueryFor(candidate = {}) {
  try {
    const host = new URL(candidate.playUrl || '').hostname.replace(/^www\./, '');
    if (host.includes('.') && !SHARED_TREND_HOST.test(host)) return host;
  } catch { /* 没有可解析的玩法 URL */ }
  return candidate.name || '';
}

export function meansFromTimeline(timelineData = [], keywordIndex = 0) {
  const values = timelineData
    .filter((p) => !p.isPartial)
    .map((p) => Number(p.value?.[keywordIndex] ?? 0))
    .filter((v) => Number.isFinite(v));
  if (!values.length) return { trends7: null, trends30: null };
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  return { trends7: +avg(values.slice(-7)).toFixed(1), trends30: +avg(values).toFixed(1) };
}

const ANSWER_HINT = /\b(answers?|solutions?|archive|walkthrough|hints?)\b/i;

export function answerNestCount(results = [], playHost = '') {
  const official = String(playHost || '').replace(/^www\./, '');
  const hosts = new Set();
  for (const result of results) {
    let host = '';
    try { host = new URL(result.url).hostname.replace(/^www\./, ''); } catch { continue; }
    if (!host || host === official || (official && host.endsWith(`.${official}`))) continue;
    if (AGG_HOST.test(host)) continue;
    const text = `${result.title || ''} ${result.snippet || ''}`;
    if (ANSWER_HINT.test(text) || ANSWER_HINT.test(host)) hosts.add(host);
  }
  return hosts.size;
}

export function classifyPublicHits(results = [], playHost = '') {
  const hosts = results.map((r) => {
    try { return new URL(r.url).hostname.replace(/^www\./, ''); } catch { return ''; }
  }).filter(Boolean);
  return {
    mediaMentions: new Set(hosts.filter((h) => MEDIA_HOST.test(h))).size,
    redditPosts7d: hosts.filter((h) => h.endsWith('reddit.com')).length,
    aggregatorHits: new Set(hosts.filter((h) => AGG_HOST.test(h))).size,
    answerNests: answerNestCount(results, playHost),
    measured: true,
  };
}

function cardPlayUrl(block) {
  return block.match(/<a\b[^>]*class="[^"]*\b(?:card-play|pick-play)\b[^"]*"[^>]*href="(https?:\/\/[^"]+)"/i)?.[1]
    || block.match(/href="(https?:\/\/[^"]+)"[^>]*class="[^"]*\b(?:card-play|pick-play)\b/i)?.[1]
    || '';
}

export function parseAllTheDlesHome(html = '') {
  const picks = [];
  const ol = html.match(/<ol class="picks"[\s\S]*?<\/ol>/i)?.[0] || '';
  for (const [index, li] of [...ol.matchAll(/<li class="pick"[\s\S]*?<\/li>/gi)].entries()) {
    const block = li[0];
    const slug = attr(block, 'data-slug');
    const name = decode(block.match(/class="pick-name"[^>]*>([\s\S]*?)<\//i)?.[1] || slug);
    if (!name) continue;
    picks.push({
      name,
      slug,
      blurb: decode(block.match(/class="pick-sum"[^>]*>([\s\S]*?)<\//i)?.[1] || ''),
      playUrl: cardPlayUrl(block),
      weeklyRank: index + 1,
      lists: ['weekly-hot'],
      isNew: /pick-new/.test(block),
      cats: '',
    });
  }
  const newly = [];
  const sec = html.match(/<h2>Newly added<\/h2>[\s\S]*?<\/section>/i)?.[0] || '';
  for (const match of sec.matchAll(/<article class="game-card"[\s\S]*?<\/article>/gi)) {
    const block = match[0];
    const slug = attr(block, 'data-slug');
    const name = decode(block.match(/<h3>([\s\S]*?)<\/h3>/i)?.[1] || slug);
    if (!name) continue;
    newly.push({
      name,
      slug,
      blurb: decode(block.match(/class="game-sum"[^>]*>([\s\S]*?)<\//i)?.[1] || ''),
      playUrl: cardPlayUrl(block),
      cats: attr(block, 'data-cats'),
      lists: ['newly-added'],
      isNew: true,
    });
  }
  return { picks, newly };
}

export function parseAllTheDlesNew(html = '') {
  const out = [];
  const parts = String(html).split(/<h2 class="day-head">/i).slice(1);
  for (const part of parts) {
    const added = parseHumanDate(part.slice(0, 80).replace(/^Added\s+/i, ''));
    const body = part.split(/<h2\b/i)[0];
    for (const match of body.matchAll(/<article class="game-card"[\s\S]*?<\/article>/gi)) {
      const block = match[0];
      const slug = attr(block, 'data-slug');
      const name = decode(block.match(/<h3>([\s\S]*?)<\/h3>/i)?.[1] || slug);
      if (!name) continue;
      const launched = parseHumanDate(block.match(/launched\s+([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})/i)?.[1] || '') || added;
      out.push({
        name,
        slug,
        blurb: decode(block.match(/class="game-sum"[^>]*>([\s\S]*?)<\//i)?.[1] || ''),
        playUrl: cardPlayUrl(block),
        cats: attr(block, 'data-cats'),
        launchedAt: launched,
        lists: ['new-60d'],
      });
    }
  }
  return out;
}

export function usableIndieName(name = '') {
  const n = String(name).trim();
  if (n.length < 3 || n.length > 42) return false;
  if (/^(test|untitled|game jam|newgrounds|my game)\b/i.test(n)) return false;
  return /[a-z]/i.test(n);
}

export function parseItchNewest(html = '') {
  const doc = parseRemoteDocument(html, 'https://itch.io/games/newest/platform-web', 'itch-listing');
  return (doc.entries || []).map((entry) => ({
    name: deriveGameName(entry),
    playUrl: entry.url,
    lists: ['itch-newest-web'],
    blurb: '',
    slug: '',
  })).filter((c) => usableIndieName(c.name));
}

export function parseNewgroundsTop(xml = '') {
  const doc = parseRemoteDocument(xml, 'https://rss.ngfiles.com/dailytop5.xml', 'feed');
  return (doc.entries || []).map((entry) => {
    let launchedAt = '';
    const parsed = Date.parse(entry.date || '');
    if (Number.isFinite(parsed)) launchedAt = new Date(parsed).toISOString().slice(0, 10);
    return {
      name: deriveGameName(entry).replace(/^\d+\.\s*/, '').replace(/\s+by\s+.+$/i, '').trim(),
      playUrl: entry.url,
      lists: ['newgrounds-daily-top'],
      blurb: '',
      launchedAt,
      slug: '',
    };
  }).filter((c) => usableIndieName(c.name));
}

function candidateKey(c) {
  return normName(c.slug || c.name);
}

export function mergeDirectoryCandidates({ picks = [], newly = [], fresh = [], indies = [] } = {}) {
  const map = new Map();
  const add = (raw) => {
    if (!raw?.name) return;
    const key = candidateKey(raw);
    if (!key) return;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { ...raw, lists: [...(raw.lists || [])] });
      return;
    }
    prev.lists = [...new Set([...(prev.lists || []), ...(raw.lists || [])])];
    prev.weeklyRank = prev.weeklyRank || raw.weeklyRank;
    prev.playUrl = prev.playUrl || raw.playUrl;
    prev.launchedAt = prev.launchedAt || raw.launchedAt;
    prev.blurb = prev.blurb || raw.blurb;
    prev.cats = prev.cats || raw.cats;
    prev.slug = prev.slug || raw.slug;
    if (raw.isNew) prev.isNew = true;
  };
  // 目录上有的都留下。上线超过两三周不是丢弃条件；/new/ 页本身列了多久，就收多久。
  picks.forEach(add);
  newly.forEach(add);
  fresh.forEach(add);
  indies.forEach(add);
  return [...map.values()];
}

function laneCountsFor(list) {
  const counts = new Map();
  for (const candidate of list) {
    const lane = detectLane(candidate.name, candidate.blurb, candidate.cats);
    if (lane === 'other') continue;
    counts.set(lane, (counts.get(lane) || 0) + 1);
  }
  return counts;
}

/** 探测顺序：周热和空车道优先。上线日最多加 8 分，压不过名次，也不能单独把人排除。 */
export function probePriority(candidate = {}, laneCounts = new Map(), now = Date.now()) {
  const lists = candidate.lists || [];
  let score = 0;
  if (candidate.weeklyRank) score += 500 - candidate.weeklyRank * 10;
  if (lists.includes('newly-added')) score += 40;
  const lane = detectLane(candidate.name, candidate.blurb, candidate.cats);
  const crowd = lane === 'other' ? 0 : (laneCounts.get(lane) || 0);
  score -= crowd * 25;
  if (candidate.trends7 != null && candidate.trends30 != null && Number(candidate.trends7) > Number(candidate.trends30)) score += 30;
  if (candidate.embed?.deny === false || candidate.oss?.deployable) score += 20;
  const nests = candidate.social?.answerNests ?? candidate.answerNests;
  if (nests >= 4) score -= 80;
  const stamp = Date.parse(candidate.launchedAt || '');
  if (Number.isFinite(stamp)) score += Math.max(0, 8 - (now - stamp) / (30 * DAY));
  return score;
}

export function selectProbeCandidates(found = [], { limit = 10, now = Date.now() } = {}) {
  const directory = found.filter((c) => !indieOnly(c));
  const counts = laneCountsFor(directory);
  const byPriority = (a, b) => probePriority(b, counts, now) - probePriority(a, counts, now);
  const weekly = directory.filter((c) => c.weeklyRank).sort(byPriority);
  const rest = directory.filter((c) => !c.weeklyRank).sort(byPriority);
  const reserve = rest.length && limit > 2 ? Math.min(2, rest.length, limit) : 0;
  const weeklyPick = weekly.slice(0, Math.max(0, limit - reserve));
  const restPick = rest.slice(0, Math.max(0, limit - weeklyPick.length));
  return [...weeklyPick, ...restPick];
}

function rankCandidates(list, now = Date.now()) {
  const counts = laneCountsFor(list);
  return [...list].sort((a, b) => probePriority(b, counts, now) - probePriority(a, counts, now));
}

function indieOnly(c) {
  const lists = c.lists || [];
  return lists.length > 0 && lists.every((l) => l === 'itch-newest-web' || l === 'newgrounds-daily-top');
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

async function fetchPage(url, fetchImpl) {
  const res = await fetchImpl(url, {
    redirect: 'follow',
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8' },
    signal: AbortSignal.timeout(12_000),
  });
  const text = await res.text();
  if (!res.ok) {
    const error = new Error(`HTTP ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return { status: res.status, headers: res.headers, text: text.slice(0, 400_000), finalUrl: res.url || url };
}

export async function probePlayPage(url, fetchImpl = fetch) {
  try {
    const page = await fetchPage(url, fetchImpl);
    const policy = parseEmbedPolicy({
      xFrameOptions: page.headers.get('x-frame-options') || '',
      contentSecurityPolicy: page.headers.get('content-security-policy') || '',
    });
    let host = '';
    try { host = new URL(page.finalUrl || url).hostname; } catch { /* ignore */ }
    if (/(^|\.)itch\.io$/i.test(host)) {
      policy.itchProject = true;
      policy.note = `itch 项目页（${policy.note}）。不要嵌项目页`;
      policy.linkability = Math.min(policy.linkability, 6);
    }
    policy.repos = extractRepoUrls(page.text);
    policy.text = page.text;
    policy.finalUrl = page.finalUrl || url;
    return policy;
  } catch (error) {
    return { xfo: 'unknown', frameAncestors: 'unknown', deny: null, linkability: 6, note: `嵌入探测失败：${error.message}`, error: true, repos: [], text: '' };
  }
}

async function githubFetch(url, fetchImpl) {
  const headers = {
    'User-Agent': UA,
    Accept: 'application/vnd.github+json',
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(12_000) });
  if (res.status === 403 || res.status === 429) return { rateLimited: true, data: null };
  if (!res.ok) return { rateLimited: false, data: null, status: res.status };
  return { rateLimited: false, data: await res.json() };
}

async function githubRepoMeta(repoUrl, fetchImpl) {
  const parsed = parseGithubRepo(repoUrl);
  if (!parsed) return { rateLimited: false };
  const repo = await githubFetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}`, fetchImpl);
  if (repo.rateLimited) return { rateLimited: true };
  const data = repo.data || {};
  let rootFiles = [];
  const contents = await githubFetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/contents/`, fetchImpl);
  if (Array.isArray(contents.data)) rootFiles = contents.data.map((f) => f.name).filter(Boolean);
  return {
    rateLimited: false,
    license: data.license?.spdx_id || '',
    language: data.language || '',
    description: data.description || '',
    topics: data.topics || [],
    rootFiles,
  };
}

async function searchGithub(name, fetchImpl, { playHost = '' } = {}) {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(`${name} game`)}&per_page=5&sort=updated`;
  const res = await githubFetch(url, fetchImpl);
  if (res.rateLimited) return { rateLimited: true, repoUrl: '' };
  const item = pickSearchRepo(res.data || {}, name, { playHost });
  return { rateLimited: false, repoUrl: item?.html_url || '' };
}

async function lookupOpenSource(candidate, page, fetchImpl, pace = { blocked: false, pause: async () => {} }) {
  try {
    if (page.error) return assessOpenSource({ status: 'unmeasured', note: '未查（玩法页没打开）' });
    let repoUrl = chooseLinkedRepo(page.repos || [], candidate);
    if (!repoUrl) {
      if (pace.blocked) return assessOpenSource({ status: 'unmeasured', note: '未查（GitHub 限流）' });
      let playHost = '';
      try { playHost = new URL(candidate.playUrl || '').hostname.replace(/^www\./, ''); } catch { /* 无玩法 URL */ }
      const searched = await searchGithub(candidate.name, fetchImpl, { playHost });
      if (searched.rateLimited) {
        pace.blocked = true;
        if (!hintSpdx(page.text || '')) return assessOpenSource({ status: 'unmeasured', note: '未查（GitHub 限流）' });
      } else {
        await pace.pause(6500);
      }
      repoUrl = searched.repoUrl || '';
    }
    if (!repoUrl) return assessOpenSource({ pageHints: page.text || '' });
    const meta = await githubRepoMeta(repoUrl, fetchImpl);
    if (meta.rateLimited) return assessOpenSource({ repoUrl, pageHints: page.text || '', license: hintSpdx(page.text || '') });
    return assessOpenSource({ repoUrl, ...meta, pageHints: page.text || '' });
  } catch (error) {
    return assessOpenSource({ status: 'unmeasured', note: `未查（${error.message.slice(0, 40)}）` });
  }
}

async function gatherSocial(name, fetchImpl, playUrl = '') {
  let playHost = '';
  try { playHost = new URL(playUrl).hostname.replace(/^www\./, ''); } catch { /* 无玩法 URL */ }
  const out = { measured: false, redditPosts7d: null, mediaMentions: null, aggregatorHits: 0, answerNests: null, note: '' };
  try {
    const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(`"${name}"`)}&sort=new&t=week&limit=25&type=link`;
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const posts = (data?.data?.children || []).map((c) => c.data || {}).filter((item) => `${item.title || ''} ${item.selftext || ''}`.toLowerCase().includes(name.toLowerCase()));
    out.redditPosts7d = posts.length;
    out.measured = true;
  } catch (error) {
    out.note = `reddit ${String(error.message || error).slice(0, 40)}`;
  }
  try {
    const url = `https://html.duckduckgo.com/html/?kl=us-en&q=${encodeURIComponent(`"${name}" game`)}`;
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const hits = classifyPublicHits(parseDuckResults(await res.text()), playHost);
    out.mediaMentions = hits.mediaMentions;
    out.aggregatorHits = hits.aggregatorHits;
    out.redditPosts7d = out.redditPosts7d == null ? hits.redditPosts7d : Math.max(out.redditPosts7d, hits.redditPosts7d);
    out.measured = true;
  } catch (error) {
    out.note = `${out.note} ddg ${String(error.message || error).slice(0, 40)}`.trim();
  }
  try {
    const url = `https://html.duckduckgo.com/html/?kl=us-en&q=${encodeURIComponent(`"${name}" answers`)}`;
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    out.answerNests = answerNestCount(parseDuckResults(await res.text()), playHost);
    out.measured = true;
  } catch (error) {
    out.note = `${out.note} answers ${String(error.message || error).slice(0, 40)}`.trim();
  }
  return out;
}

async function loadShortTrends(names, trendsImpl, pause, errors, now) {
  const out = {};
  for (let i = 0; i < names.length; i += 4) {
    const batch = names.slice(i, i + 4);
    try {
      const raw = await trendsImpl({
        keyword: [ANCHOR, ...batch],
        startTime: new Date(now - 30 * DAY),
        geo: 'US',
      });
      const timeline = JSON.parse(raw).default.timelineData || [];
      batch.forEach((name, j) => { out[name] = meansFromTimeline(timeline, j + 1); });
    } catch (error) {
      errors.push(`trends: ${String(error.message || error).slice(0, 80)}`);
      batch.forEach((name) => { out[name] = { trends7: null, trends30: null }; });
    }
    if (i + 4 < names.length) await pause(2000);
  }
  return out;
}

async function loadIndies(fetchImpl, errors) {
  const out = [];
  try {
    const page = await fetchPage('https://itch.io/games/newest/platform-web', fetchImpl);
    out.push(...parseItchNewest(page.text).slice(0, 5));
  } catch (error) {
    errors.push(`itch newest: ${String(error.message || error).slice(0, 80)}`);
  }
  try {
    const page = await fetchPage('https://rss.ngfiles.com/dailytop5.xml', fetchImpl);
    out.push(...parseNewgroundsTop(page.text).slice(0, 5));
  } catch (error) {
    errors.push(`newgrounds: ${String(error.message || error).slice(0, 80)}`);
  }
  return out;
}

function sourceCell(row) {
  const bits = [];
  if (row.weeklyRank) bits.push(`周热#${row.weeklyRank}`);
  if ((row.lists || []).includes('newly-added')) bits.push('新上架');
  if ((row.lists || []).includes('new-60d')) bits.push('目录新页');
  if ((row.lists || []).includes('itch-newest-web')) bits.push('itch');
  if ((row.lists || []).includes('newgrounds-daily-top')) bits.push('newgrounds');
  return bits.join(' · ') || '目录';
}

function trendsCell(row) {
  if (row.trends7 == null && row.trends30 == null) return '未测';
  const weak = (row.trends7 ?? 0) < 2 && (row.trends30 ?? 0) < 5;
  const query = row.trendsQuery && row.trendsQuery !== row.name ? `${row.trendsQuery} ` : '';
  const ambiguous = row.trendsQuery === row.name && !String(row.name).includes(' ') && (row.trends7 ?? 0) >= 40;
  return `${query}7d ${row.trends7 ?? '-'} / 30d ${row.trends30 ?? '-'}${weak ? ' 仍弱' : ''}${ambiguous ? ' · 可能撞普通词' : ''}`;
}

function ageCell(row) {
  if (row.launchedAt && row.novelty?.days != null) return `${row.novelty.days}天 (${row.launchedAt})`;
  if (row.launchedAt) return row.launchedAt;
  const seen = String(row.firstSeen || '').slice(0, 10);
  return seen ? `首见 ${seen}` : '日期未知';
}

function noteCell(row) {
  const bits = [row.tag];
  if (row.ip?.risk) bits.push(`IP ${row.ip.why}`);
  if (row.token) bits.push(`代币 ${row.token}`);
  if (row.social?.note) bits.push(row.social.note);
  if (row.competition?.notes?.[0]) bits.push(row.competition.notes[0]);
  return bits.filter(Boolean).join('；');
}

export function renderEarlySection(result = {}) {
  const rows = result.rows || [];
  const errors = result.errors || [];
  const lines = [
    '## 早期每日 / 社交（early / social，不当 🟢）',
    '',
    '发现不走门户联想：All the Dles 周热、新上架、目录新页上还在的游戏（不按上线天数砍），外加 itch 最新网页与 Newgrounds Daily Top（失败只记一笔）。',
    '综合 = mean(S 社交, M 动量, N 新鲜, L 可嵌, 10−C 拥挤)。N 只给新游戏加分，超过两三周也不丢。赛道满（答案站成片）才把老词压下去。S 没有独立信号时封顶 4.5；Trends 短窗弱只标「仍弱」。判决停在 🟡 早期/社交，Monkey Mart 门槛仍只给门户词。',
    '变现路径三条：嵌入路径（响应头允许才可试 iframe，头 ≠ 授权）｜内容路径（XFO/CSP 挡住时改走答案/归档，不搬题库）｜开源部署（有公开仓库就写 URL + 许可证；像静态页则标优先，通常好过干等嵌入授权）。',
    `今天目录侧 ${result.discovered ?? 0} 个，探测 ${result.probed ?? rows.length} 个。`,
    ...(errors.length ? [`> 信源缺口：${errors.join('；')}`] : []),
    '',
  ];
  if (!rows.length) {
    lines.push('今天没有探到早期候选。', '');
    return lines.filter((line, i, arr) => line !== '' || arr[i - 1] !== '').join('\n');
  }
  lines.push(
    '| 判决 | 游戏 | 综合 | S | M | N | L | C | 上线 | Trends | 嵌入路径 | 内容路径 | 开源部署 | 来源 | 备注 |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  );
  const order = { early: 0, 'early-watch': 1, 'skip-ip': 2, 'early-weak': 3 };
  const sorted = [...rows].sort((a, b) => (order[a.verdict] ?? 9) - (order[b.verdict] ?? 9) || climbScore(b) - climbScore(a));
  for (const row of sorted) {
    const d = row.dims || {};
    const paths = row.paths || monetizationPaths({ embed: row.embed, oss: row.oss });
    lines.push(`| ${row.label || EARLY_LABEL[row.verdict] || row.verdict} | ${cell(row.name)} | ${row.composite ?? '-'} | ${d.S ?? '-'} | ${d.M ?? '-'} | ${d.N ?? '-'} | ${d.L ?? '-'} | ${d.C ?? '-'} | ${cell(ageCell(row))} | ${cell(trendsCell(row))} | ${cell(paths.embed.label)} | ${cell(paths.content.label)} | ${cell(paths.oss.label)} | ${cell(sourceCell(row))} | ${cell(noteCell(row))} |`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

export function renderEarlyReport(result = {}, date = new Date().toISOString().slice(0, 10)) {
  return [
    `# 可玩游戏雷达 · 早期每日 ${date}`,
    '',
    renderEarlySection(result).trim(),
    '',
  ].join('\n');
}

export function climbScore(row = {}) {
  let score = 0;
  if (row.weeklyRank) score += 200 - row.weeklyRank * 5;
  if (row.trends7 != null && row.trends30 != null && Number(row.trends7) > Number(row.trends30)) score += 40;
  else if (row.trends7 != null && Number(row.trends7) >= 5) score += 15;
  const nests = row.social?.answerNests ?? row.competition?.answerNests ?? 0;
  score -= Number(nests) * 12;
  score -= (row.dims?.C || 0) * 4;
  if (row.paths?.embed?.open || row.paths?.oss?.deployable) score += 25;
  score += Math.min(8, (row.dims?.N || 0) / 2);
  return score;
}

export async function runEarlyPlayableWatch({
  now = new Date(),
  limit = Number(process.env.PLAYABLE_EARLY_LIMIT ?? 10),
  includeIndies = process.env.PLAYABLE_EARLY_INDIES !== '0',
  fetchImpl = fetch,
  trendsImpl = googleTrends.interestOverTime,
  pause = sleep,
  stateFile = defaultStatePath,
} = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = nowDate.getTime();
  const errors = [];
  let homeHtml = '';
  let newHtml = '';
  try { homeHtml = (await fetchPage('https://allthedles.com/', fetchImpl)).text; }
  catch (error) { errors.push(`allthedles home: ${error.message}`); }
  try { newHtml = (await fetchPage('https://allthedles.com/new/', fetchImpl)).text; }
  catch (error) { errors.push(`allthedles new: ${error.message}`); }

  const home = parseAllTheDlesHome(homeHtml);
  const fresh = parseAllTheDlesNew(newHtml);
  if (homeHtml && !home.picks.length && !home.newly.length) errors.push('allthedles home: 解析到 0 条');
  if (newHtml && !fresh.length) errors.push('allthedles new: 解析到 0 条');
  const indies = includeIndies ? await loadIndies(fetchImpl, errors) : [];
  const found = mergeDirectoryCandidates({ picks: home.picks, newly: home.newly, fresh, indies });
  // 周热优先，但给目录里非周热、车道更空的词留位置。不按上线日截断。
  const directoryPick = selectProbeCandidates(found, { limit, now: nowMs });
  const indieRoom = Math.max(0, limit - directoryPick.length);
  const indiePick = includeIndies ? rankCandidates(found.filter(indieOnly), nowMs).slice(0, Math.min(2, indieRoom)) : [];
  const chosen = [...directoryPick, ...indiePick];

  const state = stateFile ? await readJson(stateFile, { names: {} }) : { names: {} };
  for (const candidate of chosen) {
    const key = candidate.name.toLowerCase();
    const prev = state.names[key];
    candidate.firstSeen = prev?.firstSeen || nowDate.toISOString();
    state.names[key] = { ...(prev || {}), firstSeen: candidate.firstSeen, lists: candidate.lists, playUrl: candidate.playUrl || prev?.playUrl || '' };
  }

  for (const candidate of chosen) candidate.trendsQuery = trendsQueryFor(candidate);
  const trends = await loadShortTrends([...new Set(chosen.map((c) => c.trendsQuery))], trendsImpl, pause, errors, nowMs);
  const pace = { blocked: false, pause };
  for (const candidate of chosen) {
    const page = candidate.playUrl
      ? await probePlayPage(candidate.playUrl, fetchImpl)
      : { error: true, deny: null, linkability: 6, note: '无玩法 URL', repos: [], text: '' };
    candidate.embed = page;
    candidate.oss = await lookupOpenSource(candidate, page, fetchImpl, pace);
    candidate.social = await gatherSocial(candidate.name, fetchImpl, candidate.playUrl);
    candidate.trends7 = trends[candidate.trendsQuery]?.trends7 ?? null;
    candidate.trends30 = trends[candidate.trendsQuery]?.trends30 ?? null;
    await pause(150);
  }

  const peers = chosen.map((c) => ({ name: c.name, lane: detectLane(c.name, c.blurb, c.cats) }));
  const rows = chosen.map((candidate) => {
    const lane = peers.find((p) => p.name === candidate.name)?.lane || 'other';
    const competition = scoreCompetition({
      lane,
      peers: peers.filter((p) => p.name !== candidate.name),
      playUrl: candidate.playUrl,
      aggregatorHits: candidate.social?.aggregatorHits || 0,
      answerNests: candidate.social?.answerNests ?? null,
    });
    return { ...candidate, lane, ...scoreEarly({ ...candidate, competition }, nowMs) };
  });

  if (stateFile) {
    const keep = new Set(chosen.map((c) => c.name.toLowerCase()));
    for (const [key, value] of Object.entries(state.names)) {
      if (!keep.has(key) && nowMs - Date.parse(value.firstSeen || 0) > 45 * DAY) delete state.names[key];
    }
    state.lastRun = nowDate.toISOString();
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    await fs.writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  }

  return {
    rows,
    errors,
    discovered: found.length,
    probed: rows.length,
    sources: { weekly: home.picks.length, newly: home.newly.length, fresh: fresh.length, indies: indies.length },
  };
}

const IS_MAIN = import.meta.url === `file://${process.argv[1]}` || Boolean(process.argv[1]?.endsWith('playable-early-watch.mjs'));

if (IS_MAIN) {
  const result = await runEarlyPlayableWatch();
  const today = new Date().toISOString().slice(0, 10);
  const { reportPath } = await import('../../scripts/lib/reports.mjs');
  await fs.writeFile(reportPath(`RADAR-PLAYABLE-EARLY-${today}.md`), renderEarlyReport(result, today));
  const deployable = result.rows.filter((r) => r.paths?.oss?.deployable).length;
  const tagged = result.rows.filter((r) => r.verdict === 'early').length;
  console.log(`早期每日：目录 ${result.discovered}，探测 ${result.probed}，🟡 早期/社交 ${tagged}，可部署开源 ${deployable}${result.errors.length ? `；缺口 ${result.errors.join('；')}` : ''}`);
}
