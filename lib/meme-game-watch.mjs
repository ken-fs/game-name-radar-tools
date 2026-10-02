#!/usr/bin/env node
/**
 * meme-game-watch.mjs — 「梗名 + game」冒头监测（2026-10-02 加）
 *
 * 为什么需要：换皮游戏站（热梗角色 + 简单玩法）靠的是**抢在梗爆发后几天内**拿下「梗名 game」这个词。
 * 《牛来》复盘：8/5 上映、8/20 已有人上线 niulaigame.com，10/02 才看到 = 晚了 6 周。
 *
 * 信号定义：Google 联想里 `<梗名> game` 开始出现「可玩意图」补全（online / unblocked / steam / roblox …）
 * = 已经有人在搜「玩这个梗的游戏」。联想不会回显没人搜的词（实测 `zxqv blorp game` → []），
 * 但光有 `X game` 回显不算（球员名、drinking game 也会回显），必须带可玩修饰词。
 *
 * 梗名来源（全部是 RSS / API，零额度）：
 *   ① Know Your Meme 新确认词条   knowyourmeme.com/memes.rss
 *   ② Know Your Meme 新提交词条   knowyourmeme.com/memes/submissions.rss（更早、更噪）
 *   ③ Google Trends 美国每日热搜  trends.google.com/trending/rss?geo=US
 *   ④ 手动关注名单               config/meme-watch.json 的 watch[]（看到新梗就往里加）
 *   （itch.io tag-meme 本机直连/代理都 000，未接）
 *
 * 判决：
 *   🚨 冒头    可玩意图补全 ≥ 2，且上次 < 2（或第一次查到）→ macOS 通知
 *   🟢 持续    可玩意图 ≥ 2，之前已报过
 *   ⚪ 跟踪    还没有可玩意图，继续盯 21 天
 *
 * 用法：
 *   node lib/meme-game-watch.mjs              # 跑一轮，写 ../RADAR-MEME-<日期>.md
 *   node lib/meme-game-watch.mjs "niu lai" "67 meme"   # 只查这几个名字（不写状态）
 *   node lib/meme-game-watch.mjs --json
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const statePath = path.join(root, 'data', 'meme-watch-state.json');
const configPath = path.join(root, 'config', 'meme-watch.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';
const TRACK_DAYS = 21;
const ALERT_HITS = 2;

const FEEDS = [
  { id: 'kym-confirmed', url: 'https://knowyourmeme.com/memes.rss' },
  { id: 'kym-submissions', url: 'https://knowyourmeme.com/memes/submissions.rss' },
  { id: 'trends-us', url: 'https://trends.google.com/trending/rss?geo=US' },
];

// 可玩意图：补全里出现这些词 = 有人想玩
const PLAYABLE = /\b(online|unblocked|free|download|steam|roblox|fortnite|scratch|poki|crazy ?games|itch|simulator|clicker|horror|io|apk|mobile|app|ps5|xbox|switch|pc|play|browser|tycoon|obby)\b/i;
// 体育/新闻噪音：「X game today / score」是比赛不是游戏（实测 daniil medvedev game）
const SPORTS = /\b(today|tonight|score|scores|live|suspended|schedule|highlights|stats|result|results|time|channel|tickets|odds|recap|right now|won|played|stream)\b/i;

let DICT = new Set();
try { DICT = new Set((await fs.readFile('/usr/share/dict/words', 'utf8')).toLowerCase().split('\n')); } catch {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decode = (s) => s.replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function autocomplete(query) {
  try {
    const res = await fetch(
      `https://suggestqueries.google.com/complete/search?client=firefox&hl=en&gl=us&q=${encodeURIComponent(query)}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12_000) },
    );
    const d = JSON.parse(await res.text());
    return Array.isArray(d?.[1]) ? d[1] : [];
  } catch {
    return [];
  }
}

// KYM 标题形如「Jean Philanthrope / Jean Phil」「"Fuck it, you gotta fight the Hulk now"」「Verity (Minecraft ARG)」
export function cleanMemeName(title = '') {
  const name = decode(title).split(' / ')[0].replace(/\(.*?\)/g, '').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 40) return '';
  if (name.split(' ').length > 5) return ''; // 长句梗不会变成游戏名
  return name;
}

async function fetchFeedNames() {
  const out = [];
  const errors = [];
  for (const feed of FEEDS) {
    try {
      const xml = await getText(feed.url);
      for (const item of xml.split('<item>').slice(1)) {
        const name = cleanMemeName(item.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '');
        const link = decode(item.match(/<link>([\s\S]*?)<\/link>/)?.[1] || '');
        if (!name) continue;
        // Trends 热搜多是新闻/普通词：单个字典词（delivery）直接丢，KYM 不过滤（Verity 也是字典词但确是梗）
        if (feed.id === 'trends-us' && !name.includes(' ') && DICT.has(name.toLowerCase())) continue;
        out.push({ name, source: feed.id, link: feed.id === 'trends-us' ? `https://trends.google.com/trends/explore?date=now%207-d&geo=US&q=${encodeURIComponent(name)}` : link });
      }
    } catch (error) {
      errors.push(`${feed.id}: ${error.message}`);
    }
  }
  return { names: out, errors };
}

export async function checkMemeGame(name) {
  const lower = name.toLowerCase();
  const suggestions = [...new Set([...(await autocomplete(`${name} game`)), ...(await autocomplete(`${name} games`))])];
  const playable = suggestions.filter((s) => {
    const t = s.toLowerCase();
    if (!t.startsWith(lower)) return false;
    if (SPORTS.test(t)) return false;
    // 光是「X game / X games」被收录不算：实测 niu lai game（实为 drinking game）、球员名 game 都会回显
    return PLAYABLE.test(t.slice(lower.length));
  });
  return { name, suggestions, playable, hits: playable.length };
}

const slug = (name) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '');

async function domainStatus(domain) {
  try {
    const res = await fetch(`https://rdap.org/domain/${domain}`, { redirect: 'follow', headers: { 'User-Agent': UA, Accept: 'application/rdap+json' }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 404) return 'free';
    if (!res.ok) return '?';
    const d = await res.json();
    const reg = (d.events || []).find((e) => e.eventAction === 'registration')?.eventDate?.slice(0, 10);
    return reg ? `taken ${reg}` : 'taken';
  } catch {
    return '?';
  }
}

function notify(title, body) {
  const esc = (s) => String(s).replace(/["\\]/g, '\\$&');
  try {
    execFileSync('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}" sound name "Glass"`]);
  } catch {}
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

export async function runMemeWatch({ notifyOnAlert = true } = {}) {
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const state = await readJson(statePath, { names: {} });
  const firstRun = !state.lastRun;
  const config = await readJson(configPath, { watch: [] });

  const { names: feedNames, errors } = await fetchFeedNames();
  for (const n of [...feedNames, ...config.watch.map((name) => ({ name, source: 'manual', link: '' }))]) {
    const key = n.name.toLowerCase();
    if (!state.names[key]) state.names[key] = { name: n.name, source: n.source, link: n.link, firstSeen: now, history: [] };
  }

  // 过期清理：跟踪满 21 天仍没冒头的丢掉（手动名单永不过期）
  const manual = new Set(config.watch.map((n) => n.toLowerCase()));
  for (const [key, e] of Object.entries(state.names)) {
    const age = Date.now() - Date.parse(e.firstSeen);
    if (!manual.has(key) && age > TRACK_DAYS * 86400000 && !e.alertedAt) delete state.names[key];
  }

  const rows = [];
  for (const [key, e] of Object.entries(state.names)) {
    const r = await checkMemeGame(e.name);
    const prev = e.history.at(-1)?.hits ?? 0;
    e.history = [...e.history.filter((h) => h.date !== today), { date: today, hits: r.hits }].slice(-30);
    let verdict = 'track';
    if (r.hits >= ALERT_HITS) verdict = e.alertedAt ? 'ongoing' : 'alert';
    if (verdict === 'alert') {
      e.alertedAt = now;
      e.domains = {};
      for (const d of [`${slug(e.name)}game.com`, `${slug(e.name)}.com`, `play${slug(e.name)}.com`]) {
        e.domains[d] = await domainStatus(d);
      }
    }
    e.lastPlayable = r.playable.slice(0, 8);
    rows.push({ key, ...e, hits: r.hits, prev, verdict });
    await sleep(600);
  }

  state.lastRun = now;
  await fs.writeFile(statePath, JSON.stringify(state, null, 2) + '\n');

  const alerts = rows.filter((r) => r.verdict === 'alert');
  // 第一次跑是建基线：已经在热的老梗会一次性全报，不弹通知
  if (notifyOnAlert && !firstRun && alerts.length) {
    notify('🎮 梗游戏冒头', `${alerts.map((r) => r.name).join(' / ')} → 详见 RADAR-MEME-${today}.md`);
  }
  const report = renderReport(rows, today, { firstRun, errors });
  await fs.writeFile(path.join(root, '..', `RADAR-MEME-${today}.md`), report);
  return { rows, alerts, errors, firstRun };
}

const LABEL = { alert: '🚨 冒头', ongoing: '🟢 持续', track: '⚪ 跟踪' };

export function renderReport(rows, date, { firstRun = false, errors = [] } = {}) {
  const order = { alert: 0, ongoing: 1, track: 2 };
  const sorted = [...rows].sort((a, b) => order[a.verdict] - order[b.verdict] || b.hits - a.hits);
  const lines = [
    `# 梗游戏雷达 ${date}`,
    '',
    '信号：Google 联想里「<梗名> game」出现可玩意图补全（online / unblocked / steam / roblox …）。',
    `🚨 冒头 = 可玩补全 ≥ ${ALERT_HITS} 且第一次达到 → 当天就该查竞品、定玩法、买域名。`,
    firstRun ? '\n> ⚠️ 首次运行 = 建基线：已经在热的老梗会一次性标 🚨，这次不弹通知。\n' : '',
    errors.length ? `> 信源失败：${errors.join('；')}\n` : '',
    `跟踪 ${rows.length} 个 · 🚨 ${rows.filter((r) => r.verdict === 'alert').length} · 🟢 ${rows.filter((r) => r.verdict === 'ongoing').length}`,
    '',
  ];
  const hot = sorted.filter((r) => r.verdict !== 'track');
  if (hot.length) {
    lines.push('| 判决 | 梗 | 可玩补全 | 来源 | 首见 | 域名 |', '|---|---|---|---|---|---|');
    for (const r of hot) {
      const domains = Object.entries(r.domains || {}).map(([d, s]) => `${d} ${s === 'free' ? '✅可注册' : s}`).join('<br>');
      lines.push(`| ${LABEL[r.verdict]} | ${r.link ? `[${r.name}](${r.link})` : r.name} | ${r.hits}（上次 ${r.prev}）：${r.lastPlayable.slice(0, 4).join(' · ')} | ${r.source} | ${r.firstSeen.slice(0, 10)} | ${domains || '-'} |`);
    }
    lines.push('');
  }
  const tracking = sorted.filter((r) => r.verdict === 'track');
  if (tracking.length) {
    lines.push(`<details><summary>⚪ 跟踪中 ${tracking.length} 个（还没有可玩意图）</summary>`, '', tracking.map((r) => `${r.name}（${r.source}）`).join(' · '), '', '</details>', '');
  }
  lines.push('下一步（🚨 项）：①确认梗是网友原创而非公司 IP ②看补全里有没有 roblox/steam = 已有人做 ③挑简单玩法换皮 ④`node scripts/spaceship.mjs check <域名>`');
  return lines.join('\n') + '\n';
}

const IS_MAIN = import.meta.url === `file://${process.argv[1]}` || Boolean(process.argv[1]?.endsWith('meme-game-watch.mjs'));

if (IS_MAIN) {
  const args = process.argv.slice(2);
  const names = args.filter((a) => !a.startsWith('--'));
  if (names.length) {
    const results = [];
    for (const n of names) { results.push(await checkMemeGame(n)); await sleep(600); }
    if (args.includes('--json')) console.log(JSON.stringify(results, null, 2));
    else for (const r of results) console.log(`${r.hits >= ALERT_HITS ? '🚨' : '⚪'} ${r.name}：可玩补全 ${r.hits} → ${r.playable.join(' | ') || '无'}`);
  } else {
    const { rows, alerts, errors, firstRun } = await runMemeWatch();
    if (args.includes('--json')) console.log(JSON.stringify({ alerts, errors }, null, 2));
    else console.log(`梗游戏雷达：跟踪 ${rows.length} 个，🚨 ${alerts.length}${firstRun ? '（首次建基线）' : ''}${errors.length ? `；信源失败 ${errors.join('；')}` : ''}${alerts.length ? ` → ${alerts.map((r) => r.name).join(' / ')}` : ''}`);
  }
}
