#!/usr/bin/env node
/**
 * meme-game-watch.mjs — 「梗名 + game」冒头监测（2026-10-02 加）
 *
 * 为什么需要：换皮游戏站（热梗角色 + 简单玩法）靠的是**抢在梗爆发后几天内**拿下「梗名 game」这个词。
 * 《牛来》复盘：8/5 上映、8/20 已有人上线 niulaigame.com，10/02 才看到 = 晚了 6 周。
 *
 * 信号定义：Google 联想里 `<梗名> game`（各国用本地语言：juego / jeu / spiel / gioco / ゲーム / 게임）
 * 开始出现「可玩意图」补全（online / steam / roblox / gratis / 無料 / 무료 …）= 已经有人在搜「玩这个梗的游戏」。
 * 联想不会回显没人搜的词（实测 `zxqv blorp game` → []），但光有 `X game` 回显不算
 * （球员名、drinking game 也会回显），必须带可玩修饰词。
 *
 * 市场：高 CPM 发达国家 —— 英语（US/GB/CA/AU）+ 德法西意 + 日韩。
 *
 * 梗名来源（全部是 RSS / API，零额度）：
 *   ① Know Your Meme 新确认 / 新提交词条（英文，查 US）
 *   ② Google Trends 各国每日热搜 trends.google.com/trending/rss?geo=XX（查该国本地语言）
 *   ③ 手动关注名单 config/meme-watch.json 的 watch[]（查全部本地语言；看到新梗就往里加）
 *   （itch.io tag-meme 本机直连/代理都 000，未接）
 *
 * 判决（按各市场里最高的可玩补全数）：
 *   🚨 冒头    可玩意图补全 ≥ 2，且之前没报过 → macOS 通知
 *   🟢 持续    可玩意图 ≥ 2，之前已报过
 *   ⚪ 跟踪    还没有可玩意图，继续盯 21 天
 *
 * 用法：
 *   node lib/meme-game-watch.mjs                         # 跑一轮，写 ../RADAR-MEME-<日期>.md
 *   node lib/meme-game-watch.mjs "niu lai" "ちいかわ"     # 只查这几个名字，全部市场（不写状态）
 *   node lib/meme-game-watch.mjs --market=jp,kr "ちいかわ"
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

// 各语言都通用的可玩词（平台名 / 设备）
const SHARED_PLAYABLE = /\b(online|unblocked|steam|roblox|fortnite|scratch|poki|crazy ?games|friv|itch|apk|io|ps5|xbox|switch|pc|mobile|app|browser|simulator|clicker|tycoon|obby|horror)\b/i;
const LANGS = {
  en: { playable: ['free', 'download', 'play'], sports: /\b(today|tonight|score|scores|live|suspended|schedule|highlights|stats|results?|time|channel|tickets|odds|recap|right now|won|played|stream)\b/i },
  // spielen / jouer 也是「演奏乐器」（konnte freddie mercury gitarre spielen，10-03 误报），不算可玩意图
  de: { playable: ['kostenlos', 'herunterladen', 'handy'], sports: /(heute|live|ergebnis|spielplan|liveticker|übertragung)/i },
  fr: { playable: ['gratuit', 'télécharger', 'en ligne', 'horreur'], sports: /(ce soir|en direct|score|résultat|match|quand)/i },
  es: { playable: ['gratis', 'jugar', 'descargar', 'en línea', 'terror', 'celular', 'móvil'], sports: /(hoy|en vivo|resultado|horario|partido|marcador)/i },
  it: { playable: ['gratis', 'giocare', 'scaricare', 'orrore'], sports: /(oggi|diretta|risultato|partita)/i },
  ja: { playable: ['無料', 'オンライン', 'スマホ', 'アプリ', 'ブラウザ', '攻略', 'ホラー'], sports: /(結果|速報|中継|何時|試合)/ },
  ko: { playable: ['무료', '온라인', '하기', '다운', '모바일', '공략', '로블록스', '스팀', '코드'], sports: /(결과|중계|일정|경기)/ },
};
const MEDIA = /(lyrics|song|album|movie|film|cast|trailer|episode|letra|canción|paroles|chanson|songtext|testo|歌詞|映画|가사|영화)/i;
export const MARKETS = {
  us: { hl: 'en', gl: 'us', words: ['game', 'games'] },
  gb: { hl: 'en', gl: 'gb', words: ['game', 'games'] },
  ca: { hl: 'en', gl: 'ca', words: ['game', 'games'] },
  au: { hl: 'en', gl: 'au', words: ['game', 'games'] },
  de: { hl: 'de', gl: 'de', words: ['spiel'] },
  fr: { hl: 'fr', gl: 'fr', words: ['jeu', 'jeux'] },
  es: { hl: 'es', gl: 'es', words: ['juego', 'juegos'] },
  it: { hl: 'it', gl: 'it', words: ['gioco', 'giochi'] },
  jp: { hl: 'ja', gl: 'jp', words: ['ゲーム'] },
  kr: { hl: 'ko', gl: 'kr', words: ['게임'] },
};
// 手动名单查这些（GB/CA/AU 的英文联想和 US 几乎一样，省掉）
const MANUAL_MARKETS = ['us', 'de', 'fr', 'es', 'it', 'jp', 'kr'];

const FEEDS = [
  { id: 'kym-confirmed', url: 'https://knowyourmeme.com/memes.rss', markets: ['us'] },
  { id: 'kym-submissions', url: 'https://knowyourmeme.com/memes/submissions.rss', markets: ['us'] },
  ...Object.keys(MARKETS).map((m) => ({ id: `trends-${m}`, url: `https://trends.google.com/trending/rss?geo=${m.toUpperCase()}`, markets: [m] })),
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decode = (s) => s.replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function autocomplete(query, { hl, gl }) {
  try {
    const res = await fetch(
      `https://suggestqueries.google.com/complete/search?client=firefox&hl=${hl}&gl=${gl}&q=${encodeURIComponent(query)}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12_000) },
    );
    const d = JSON.parse(new TextDecoder().decode(await res.arrayBuffer()));
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
      if (feed.id.startsWith('kym-')) {
        // KYM 10-03 起对本机 IP 403（Cloudflare），直连失败就走 r.jina.ai 阅读服务（输出 `### [标题](链接)`）
        let viaReader = null;
        try { await getText(feed.url).then((xml) => { viaReader = xml; }); } catch {}
        if (!viaReader || !viaReader.includes('<item>')) {
          const md = await getText(`https://r.jina.ai/${feed.url}`);
          for (const m of md.matchAll(/^### \[(.+?)\]\((https:\/\/knowyourmeme\.com\/memes\/[^)\s]+)\)/gm)) {
            const name = cleanMemeName(m[1]);
            if (name) out.push({ name, source: feed.id, link: m[2], markets: feed.markets });
          }
          continue;
        }
      }
      const xml = await getText(feed.url);
      for (const item of xml.split('<item>').slice(1)) {
        const name = cleanMemeName(item.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '');
        if (!name) continue;
        const isTrends = feed.id.startsWith('trends-');
        // Trends 热搜多是新闻/普通词（delivery / tiempo / flugzeugträger）：拉丁字母单个词直接丢，
        // 单词梗交给 KYM / 手动名单（Verity 就是从 KYM 来的）；日韩没有空格，只能靠阈值兜
        if (isTrends && !name.includes(' ') && /^[\p{Script=Latin}\d'-]+$/u.test(name)) continue;
        // 日韩：3 字以内多是普通词（アニメ / 介護 / ライフ，10-03 误报），ちいかわ 这类 4 字以上的梗名保留
        if (isTrends && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(name) && [...name.replace(/\s/g, '')].length <= 3) continue;
        const geo = feed.markets[0].toUpperCase();
        const link = isTrends
          ? `https://trends.google.com/trends/explore?date=now%207-d&geo=${geo}&q=${encodeURIComponent(name)}`
          : decode(item.match(/<link>([\s\S]*?)<\/link>/)?.[1] || '');
        out.push({ name, source: feed.id, link, markets: feed.markets });
      }
    } catch (error) {
      errors.push(`${feed.id}: ${error.message}`);
    }
  }
  return { names: out, errors };
}

function isPlayable(suggestion, name, lang) {
  const t = suggestion.toLowerCase();
  const n = name.toLowerCase();
  // 本地语言联想常把梗名放中间（juego roblox tung tung sahur），所以只要求包含
  if (!t.includes(n)) return false;
  const rest = t.replace(n, ' ');
  if (LANGS[lang].sports.test(rest)) return false;
  // 歌曲/影视：「freddie mercury play the game lyrics」是皇后乐队的歌，不是游戏（10-03 误报）
  if (MEDIA.test(rest)) return false;
  // 光是「X game / X juego」被收录不算：实测 niu lai game（实为 drinking game）、球员名 game 都会回显
  // 拉丁词按整词匹配（gameplay ≠ play）；日韩没有空格分词，按子串
  const word = (w) => (/^[\p{Script=Latin} ]+$/u.test(w) ? new RegExp(`(^|\\s)${w}(\\s|$)`).test(rest) : rest.includes(w));
  return SHARED_PLAYABLE.test(rest) || LANGS[lang].playable.some(word);
}

export async function checkMemeGame(name, markets = MANUAL_MARKETS) {
  const byMarket = {};
  for (const m of markets) {
    const cfg = MARKETS[m];
    const suggestions = [];
    for (const w of cfg.words) {
      suggestions.push(...(await autocomplete(`${name} ${w}`, cfg)));
      await sleep(300);
    }
    const playable = [...new Set(suggestions)].filter((s) => isPlayable(s, name, cfg.hl));
    byMarket[m] = playable;
  }
  const best = Object.entries(byMarket).sort((a, b) => b[1].length - a[1].length)[0] || [null, []];
  return { name, byMarket, hits: best[1].length, bestMarket: best[0], playable: best[1] };
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

const PUSH_SCRIPT = new URL('../../scripts/notify.mjs', import.meta.url).pathname;

function notify(title, body) {
  // 先推飞书（Ship/scripts/notify.mjs，2026-10-11 加：用户不在电脑前会漏 macOS 通知）；推不出去再走下面的 macOS 通知。
  try {
    execFileSync(process.execPath, [PUSH_SCRIPT, '--title', String(title), '--body', String(body)], { stdio: 'ignore', timeout: 30000 });
    return;
  } catch {}
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
  const manualNames = config.watch.map((name) => ({ name, source: 'manual', link: '', markets: MANUAL_MARKETS }));
  for (const n of [...feedNames, ...manualNames]) {
    const key = n.name.toLowerCase();
    const e = (state.names[key] ||= { name: n.name, source: n.source, link: n.link, firstSeen: now, history: [], markets: [] });
    e.markets = [...new Set([...(e.markets || ['us']), ...n.markets])];
    if (n.source === 'manual') e.markets = [...new Set([...e.markets, ...MANUAL_MARKETS])];
  }

  // 过期清理：跟踪满 21 天仍没冒头的丢掉（手动名单永不过期）
  const manual = new Set(config.watch.map((n) => n.toLowerCase()));
  for (const [key, e] of Object.entries(state.names)) {
    const age = Date.now() - Date.parse(e.firstSeen);
    if (!manual.has(key) && age > TRACK_DAYS * 86400000 && !e.alertedAt) delete state.names[key];
  }

  const rows = [];
  for (const [key, e] of Object.entries(state.names)) {
    const r = await checkMemeGame(e.name, e.markets);
    const prev = e.history.at(-1)?.hits ?? 0;
    const counts = Object.fromEntries(Object.entries(r.byMarket).map(([m, p]) => [m, p.length]));
    e.history = [...e.history.filter((h) => h.date !== today), { date: today, hits: r.hits, byMarket: counts }].slice(-30);
    let verdict = 'track';
    if (r.hits >= ALERT_HITS) verdict = e.alertedAt ? 'ongoing' : 'alert';
    if (verdict === 'alert') {
      e.alertedAt = now;
      e.domains = {};
      // 日韩原文名 slug 为空 → 不查域名，要手动起英文/罗马字名
      const s = slug(e.name);
      if (s) for (const d of [`${s}game.com`, `${s}.com`, `play${s}.com`]) e.domains[d] = await domainStatus(d);
    }
    e.lastPlayable = r.playable.slice(0, 8);
    rows.push({ key, ...e, hits: r.hits, prev, counts, bestMarket: r.bestMarket, verdict });
  }

  state.lastRun = now;
  await fs.writeFile(statePath, JSON.stringify(state, null, 2) + '\n');

  const alerts = rows.filter((r) => r.verdict === 'alert');
  // 第一次跑是建基线：已经在热的老梗会一次性全报，不弹通知
  if (notifyOnAlert && !firstRun && alerts.length) {
    notify('🎮 梗游戏冒头', `${alerts.map((r) => `${r.name}(${r.bestMarket})${isUnconfirmed(r) ? '⚠️热搜未确认' : ''}`).join(' / ')} → 详见 RADAR-MEME-${today}.md`);
  }
  const report = renderReport(rows, today, { firstRun, errors });
  await fs.writeFile(path.join(root, '..', `RADAR-MEME-${today}.md`), report);
  return { rows, alerts, errors, firstRun };
}

const LABEL = { alert: '🚨 冒头', ongoing: '🟢 持续', track: '⚪ 跟踪' };
// trends-rss 来源是**地区热搜榜**（新闻/体育/地名/人名词居多），不等于网友梗——必须人工确认。
// 2026-10-08 实例：amitabh bachchan（印度影星上 CA 热搜）、sud ouest（法语“西南”，地理词）。
const isUnconfirmed = (r) => String(r.source).startsWith('trends-');

export function renderReport(rows, date, { firstRun = false, errors = [] } = {}) {
  const order = { alert: 0, ongoing: 1, track: 2 };
  const sorted = [...rows].sort((a, b) => order[a.verdict] - order[b.verdict] || b.hits - a.hits);
  const trendsAlerts = rows.filter((r) => r.verdict === 'alert' && isUnconfirmed(r)).length;
  const lines = [
    `# 梗游戏雷达 ${date}`,
    '',
    '信号：Google 联想里「<梗名> game / juego / jeu / spiel / gioco / ゲーム / 게임」出现可玩意图补全。',
    '市场：US / GB / CA / AU / DE / FR / ES / IT / JP / KR（高 CPM）。',
    '⚠️ 来源是 trends-xx 的多为新闻 / 老 IP（如 friday the 13th、ケロロ軍曹），要人工确认是不是网友梗；kym / manual 来源更可信。',
    `🚨 冒头 = 任一市场可玩补全 ≥ ${ALERT_HITS} 且第一次达到 → 当天就该查竞品、定玩法、买域名。`,
    firstRun ? '\n> ⚠️ 首次运行 = 建基线：已经在热的老梗会一次性标 🚨，这次不弹通知。\n' : '',
    errors.length ? `> 信源失败：${errors.join('；')}\n` : '',
    `跟踪 ${rows.length} 个 · 🚨 ${rows.filter((r) => r.verdict === 'alert').length}${trendsAlerts ? `（其中 ${trendsAlerts} 个来自地区热搜，未确认是梗，先人工筛）` : ''} · 🟢 ${rows.filter((r) => r.verdict === 'ongoing').length}`,
    '',
  ];
  const hot = sorted.filter((r) => r.verdict !== 'track');
  if (hot.length) {
    lines.push('| 判决 | 梗 | 各市场可玩补全 | 例子 | 来源 | 首见 | 域名 |', '|---|---|---|---|---|---|---|');
    for (const r of hot) {
      const domains = Object.entries(r.domains || {}).map(([d, s]) => `${d} ${s === 'free' ? '✅可注册' : s}`).join('<br>');
      const counts = Object.entries(r.counts).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]).map(([m, c]) => `${m.toUpperCase()} ${c}`).join(' · ');
      const unconfirmed = isUnconfirmed(r);
      lines.push(`| ${LABEL[r.verdict]}${r.verdict === 'alert' && unconfirmed ? ' ⚠️' : ''} | ${r.link ? `[${r.name}](${r.link})` : r.name} | ${counts}（上次最高 ${r.prev}） | ${r.lastPlayable.slice(0, 3).join(' · ')} | ${r.source}${unconfirmed ? '（热搜，未确认是梗）' : ''} | ${r.firstSeen.slice(0, 10)} | ${domains || '-'} |`);
    }
    lines.push('');
  }
  const tracking = sorted.filter((r) => r.verdict === 'track');
  if (tracking.length) {
    lines.push(`<details><summary>⚪ 跟踪中 ${tracking.length} 个（还没有可玩意图）</summary>`, '', tracking.map((r) => `${r.name}（${r.source}）`).join(' · '), '', '</details>', '');
  }
  lines.push('下一步（🚨 项）：①确认梗是网友原创而非公司 IP ②看补全里有没有 roblox/steam = 已有人做 ③挑简单玩法换皮（非英语市场要做本地语言落地页）④`node scripts/spaceship.mjs check <域名>`');
  return lines.join('\n') + '\n';
}

const IS_MAIN = import.meta.url === `file://${process.argv[1]}` || Boolean(process.argv[1]?.endsWith('meme-game-watch.mjs'));

if (IS_MAIN) {
  const args = process.argv.slice(2);
  const names = args.filter((a) => !a.startsWith('--'));
  const marketArg = args.find((a) => a.startsWith('--market='))?.split('=')[1];
  const markets = marketArg ? marketArg.split(',').filter((m) => MARKETS[m]) : MANUAL_MARKETS;
  if (names.length) {
    const results = [];
    for (const n of names) results.push(await checkMemeGame(n, markets));
    if (args.includes('--json')) console.log(JSON.stringify(results, null, 2));
    else for (const r of results) {
      const counts = Object.entries(r.byMarket).map(([m, p]) => `${m.toUpperCase()} ${p.length}`).join(' · ');
      console.log(`${r.hits >= ALERT_HITS ? '🚨' : '⚪'} ${r.name}：${counts}${r.hits ? ` → ${r.playable.slice(0, 4).join(' | ')}` : ''}`);
    }
  } else {
    const { rows, alerts, errors, firstRun } = await runMemeWatch();
    if (args.includes('--json')) console.log(JSON.stringify({ alerts, errors }, null, 2));
    else console.log(`梗游戏雷达：跟踪 ${rows.length} 个，🚨 ${alerts.length}${firstRun ? '（首次建基线）' : ''}${errors.length ? `；信源失败 ${errors.join('；')}` : ''}${alerts.length ? ` → ${alerts.map((r) => `${r.name}(${r.bestMarket})`).join(' / ')}` : ''}`);
  }
}
