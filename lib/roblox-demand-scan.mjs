/**
 * 第 3 层 · 需求验证（Roblox 选站四层漏斗的最关键一层）
 *
 * 对候选游戏做两件事，对应用户方法论：
 *   1. Google Trends 曲线形状：拉 {游戏名} codes 的 90 天曲线，判"高位稳住/上升"（做）
 *      还是"一座尖峰后掉头"（短命，弃）还是"基本零量"（弃）。
 *   2. 子关键词构成：拉 Google 自动补全，看长尾里是攻略词（codes/tier list/wiki/
 *      badges/trello/pets…=玩家在找攻略=做）还是清一色发布词（release/trailer/
 *      release date=只想看发布时间=没攻略流量=弃）。
 *
 * 双源规则：Trends 与子关键词都正 → GO；只有一个正 → 观察；有一个明确否 → 放弃。
 *
 * 免费、无需 key：google-trends-api（Trends）+ suggestqueries.google.com（自动补全）。
 *
 * 用法：node lib/roblox-demand-scan.mjs "游戏名" ["游戏名2" ...]
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// 2026-10-08：google-trends-api 不带 Cookie，天天被 302 到 /sorry；换成带 Cookie 的同接口替身
import googleTrends from './google-trends.mjs';

const GEO = process.env.TARGET_MARKET || 'US';
const DAY = 86400000;
// 量级锚点：候选与锚点同查一次，Google 用同一尺子归一化 → 得出"候选≈锚点的百分之几"。
// 设 TRENDS_ANCHOR=none 关闭量级对比。TRENDS_ANCHOR_VOLUME 可选（锚点已知月/日搜索量）→ 输出绝对估算。
const ANCHOR = (process.env.TRENDS_ANCHOR ?? 'blox fruits codes').trim();
const ANCHOR_VOLUME = Number(process.env.TRENDS_ANCHOR_VOLUME || 0);
const ANCHOR_ON = ANCHOR && ANCHOR.toLowerCase() !== 'none';

// 攻略意图长尾（和 wiki-prelaunch.mjs / fast-signals.mjs 的 Roblox 语料保持一致）
const GUIDE_TERMS = /\b(codes?|tier ?list|value ?list|values?|trello|wiki|guide|walkthrough|badges?|how to get|update ?log|scripts?|units?|pets?|eggs?|mutations?|aura|fruit|weapons?|items?|boss(?:es)?|quest|rebirth|gems?|recipe|craft(?:ing)?|map)\b/i;
// 发布意图长尾（只想看发布时间/预告 = 没攻略流量）
const RELEASE_TERMS = /\b(release ?date|releasing|trailer|coming soon|is it out|when(?:'?s| is| does| will).{0,12}(out|release)|announcement|teaser|beta|demo|leak|pre[- ]?order|wishlist)\b/i;

function unique(values) { return [...new Set(values.filter(Boolean))]; }
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchSuggestions(query) {
  try {
    const url = `https://suggestqueries.google.com/complete/search?client=firefox&hl=en&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { accept: 'application/json,text/plain,*/*' } });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.[1]) ? data[1].map(String) : [];
  } catch {
    return [];
  }
}

async function interestSeries(keyword) {
  try {
    const raw = await googleTrends.interestOverTime({
      keyword,
      startTime: new Date(Date.now() - 90 * DAY),
      geo: GEO,
    });
    const json = JSON.parse(raw);
    const points = (json.default?.timelineData || [])
      .map((p) => (Array.isArray(p.value) ? Number(p.value[0]) : Number(p.value)))
      .filter((v) => Number.isFinite(v));
    return points;
  } catch {
    return null; // 未测（可能被 Google 限频）
  }
}

// 候选与锚点同查一次：返回两列同尺子归一化后的近期均值，算出候选相对锚点的量级比例
async function anchorMagnitude(name) {
  if (!ANCHOR_ON) return null;
  try {
    const raw = await googleTrends.interestOverTime({
      keyword: [`${name} codes`, ANCHOR],
      startTime: new Date(Date.now() - 90 * DAY),
      geo: GEO,
    });
    const rows = (JSON.parse(raw).default?.timelineData || [])
      .map((p) => (Array.isArray(p.value) ? p.value.map(Number) : []))
      .filter((v) => v.length >= 2 && v.every(Number.isFinite));
    if (rows.length < 6) return { ok: false };
    const recentN = Math.max(6, Math.floor(rows.length * 0.15));
    const candRecent = mean(rows.slice(-recentN).map((r) => r[0]));
    const ankRecent = mean(rows.slice(-recentN).map((r) => r[1]));
    const candPeak = Math.max(...rows.map((r) => r[0]));
    const ankPeak = Math.max(...rows.map((r) => r[1]));
    // 近期锚点接近零时退回用峰值比，避免除零放大
    const ratio = ankRecent >= 3 ? candRecent / ankRecent : (ankPeak > 0 ? candPeak / ankPeak : null);
    const basis = ankRecent >= 3 ? 'recent' : 'peak';
    return { ok: true, ratio, basis, candRecent, ankRecent, candPeak, ankPeak };
  } catch {
    return { ok: false };
  }
}

// 判曲线形状：no-volume / spike / declining / rising-hold / rising / high-stable
// 注意 interestOverTime 自归一化（峰值恒=100），所以只能判"时间形状"（是否塌到近零），
// 不能判绝对量级；量级需 anchor 词对比（见 analyze 里的可选 anchor）。
function classifyShape(points) {
  if (!points || points.length < 6) return { shape: 'no-data', peak: 0, recent: 0 };
  const peak = Math.max(...points);
  if (peak < 5) return { shape: 'no-volume', peak, recent: mean(points.slice(-8)) };
  const third = Math.max(1, Math.floor(points.length / 3));
  const firstMean = mean(points.slice(0, third));
  const lastMean = mean(points.slice(-third));
  const recent = mean(points.slice(-Math.max(6, Math.floor(points.length * 0.15))));
  const peakIdx = points.indexOf(peak);
  const peakEarly = peakIdx < points.length * 0.6;
  const ratio = recent / peak; // 近期相对历史峰值的持有比例

  // 只有近期塌到接近零（<12% 峰值）才算"死"：早峰=尖峰退潮，晚峰=持续下滑
  if (ratio < 0.12) return { shape: peakEarly ? 'spike' : 'declining', peak, recent, firstMean, lastMean };
  if (ratio >= 0.45 && lastMean >= firstMean * 1.15) return { shape: 'rising-hold', peak, recent, firstMean, lastMean };
  if (lastMean >= firstMean * 1.5) return { shape: 'rising', peak, recent, firstMean, lastMean };
  return { shape: 'high-stable', peak, recent, firstMean, lastMean }; // 在有意义的比例上持有=活着
}

function classifySubkeywords(name, suggestions) {
  const lower = name.toLowerCase();
  const rel = unique(suggestions.map((s) => s.toLowerCase().trim())).filter((s) => s.includes(lower) || suggestions.length <= 12);
  const guide = rel.filter((s) => GUIDE_TERMS.test(s));
  const release = rel.filter((s) => RELEASE_TERMS.test(s) && !GUIDE_TERMS.test(s));
  let verdict;
  if (guide.length >= 2 && guide.length >= release.length) verdict = 'guide-rich';
  else if (guide.length >= 1 && guide.length >= release.length) verdict = 'guide-some';
  else if (release.length > 0 && guide.length === 0) verdict = 'release-only';
  else if (rel.length === 0) verdict = 'empty';
  else verdict = 'mixed';
  return { verdict, guide, release, all: rel };
}

// 综合判决（双源规则）
function combine(trends, sub) {
  const trendsPos = ['rising-hold', 'high-stable', 'rising'].includes(trends.shape);
  const trendsNeg = ['spike', 'no-volume', 'declining'].includes(trends.shape);
  const subPos = ['guide-rich', 'guide-some'].includes(sub.verdict);
  const subNeg = sub.verdict === 'release-only';

  if (subNeg) return { decision: '放弃', why: '子关键词清一色发布词，无攻略搜索需求' };
  if (trends.shape === 'spike') {
    // codes 词是事件驱动、天然会回落；若子关键词仍显示攻略需求，降级为观察而非直接放弃
    return subPos
      ? { decision: '🟡 观察', why: 'Trends(codes) 已从发布尖峰回落，但子关键词仍有攻略词——codes 词回落可能是误导，建议核实游戏当前热度' }
      : { decision: '放弃', why: 'Trends 一座尖峰后掉头，且无攻略长尾，短命热度' };
  }
  if (trends.shape === 'no-volume' && !subPos) return { decision: '放弃', why: 'Trends 基本零量且无攻略长尾' };
  if (trendsPos && subPos) return { decision: '🟢 GO', why: 'Trends 上升/高位稳住 + 子关键词含攻略词（双源确认）' };
  if (trendsPos || subPos) return { decision: '🟡 观察', why: `仅单一来源为正（${trendsPos ? 'Trends' : ''}${subPos ? '子关键词' : ''}），按双源规则先观察一周` };
  if (trends.shape === 'no-data') return { decision: '🟡 观察', why: 'Trends 未取到数据（可能限频），仅凭子关键词不足以定' };
  return { decision: '放弃', why: '需求信号不足' };
}

async function analyze(name) {
  // 优先用 {game} codes（Roblox 最高信号词）；零量再退到 {game} wiki
  let series = await interestSeries(`${name} codes`);
  let anchorWord = 'codes';
  let trends = classifyShape(series);
  if (trends.shape === 'no-volume' || trends.shape === 'no-data') {
    await sleep(1200);
    const wikiSeries = await interestSeries(`${name} wiki`);
    const wikiShape = classifyShape(wikiSeries);
    if (wikiShape.peak > trends.peak) { series = wikiSeries; anchorWord = 'wiki'; trends = wikiShape; }
  }
  let magnitude = null;
  if (ANCHOR_ON) { await sleep(1200); magnitude = await anchorMagnitude(name); }
  const suggestions = await fetchSuggestions(`${name} `);
  const sub = classifySubkeywords(name, suggestions);
  const decision = combine(trends, sub);
  return { name, anchorWord, trends, sub, magnitude, decision };
}

export { analyze, classifyShape, classifySubkeywords, combine };

async function main() {
  const games = process.argv.slice(2);
  if (!games.length) {
    console.log('用法: node lib/roblox-demand-scan.mjs "游戏名" ["游戏名2" ...]');
    process.exit(1);
  }
  console.log(`\n═══ 第 3 层 · 需求验证（Trends 曲线 + 子关键词构成）· 市场 ${GEO} ═══\n`);
  for (const game of games) {
    const r = await analyze(game);
    console.log(`── ${game}`);
    const t = r.trends;
    if (t.shape === 'no-data') {
      console.log(`   Trends(${r.anchorWord}): 未测（可能被 Google 限频，稍后重试）`);
    } else {
      console.log(`   Trends(${r.anchorWord}): 形状=${t.shape} · 峰值 ${t.peak} · 近期均值 ${Math.round(t.recent)}`);
    }
    if (r.magnitude?.ok && r.magnitude.ratio != null) {
      const pct = Math.round(r.magnitude.ratio * 100);
      const abs = ANCHOR_VOLUME > 0 ? ` ≈ ${Math.round(r.magnitude.ratio * ANCHOR_VOLUME).toLocaleString()}/期` : '';
      console.log(`   量级: 近期约锚点(${ANCHOR})的 ${pct}%${abs}${r.magnitude.basis === 'peak' ? '（锚点近期偏低，按峰值比估）' : ''}`);
    } else if (ANCHOR_ON) {
      console.log(`   量级: 未测（锚点对比限频/数据不足）`);
    }
    if (r.sub.all.length) {
      console.log(`   子关键词: ${r.sub.verdict}  攻略词[${r.sub.guide.length}]${r.sub.guide.slice(0, 5).map((s) => ` "${s}"`).join('')}${r.sub.release.length ? `  发布词[${r.sub.release.length}]` : ''}`);
    } else {
      console.log('   子关键词: 自动补全无结果');
    }
    console.log(`   判决: ${r.decision.decision} — ${r.decision.why}\n`);
    await sleep(1500); // 降低 Google Trends 限频概率
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
