#!/usr/bin/env node
/**
 * 否决候选到期复测：需求型否决按 +3/+7/+14/+30 天复测；预发布按发售 +3/+7/+14 天。
 * 结构型否决（IP / 无实体 / 成熟竞品等）不自动跑，人工改 status=active 才会进队列。
 *
 * 复用现有闸门，不另造评分：Roblox = roblox-demand-scan；Steam = steam-gate；
 * 其他平台 = radar.mjs check。只有判决上升且有真实需求证据才标 flip；网络失败次日重试。
 * flip ≠ 建站 GO，只表示该重新做 SERP / 实体 / 竞品复核。
 *
 * 用法：node lib/rejection-recheck.mjs [--dry-run]（dry-run 不写账本、不通知、不写报告）
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { notify } from '../../scripts/notify.mjs';
import { reportPath } from '../../scripts/lib/reports.mjs';
import { analyze } from './roblox-demand-scan.mjs';
import { codesMediaBatch } from './codes-media.mjs';
import { steamGate } from './steam-gate.mjs';
import { onRoblox } from '../radar.mjs';

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER = join(ROOT, 'data', 'rejections.json');
const DAY = 86400_000;
const OFFSETS = [3, 7, 14, 30];
const RELEASE_OFFSETS = [3, 7, 14];
const ymd = (d) => new Date(d).toISOString().slice(0, 10);
const addDays = (date, n) => ymd(Date.parse(`${date}T00:00:00Z`) + n * DAY);

export function verdictRank(v = '') {
  if (/🟢|✅/.test(v)) return 2;
  if (/🟡|🌱/.test(v)) return 1;
  return 0;
}

export function isFlip(before, after, evidence) {
  return Boolean(evidence) && verdictRank(after) > verdictRank(before);
}

/** 下一次计划日复测；已过全部节点 = null。新候选当天决定时自然落在 +3 天。 */
export function nextScheduled(entry, fromDate) {
  const base = entry.category === 'pre-release' ? entry.releaseDate : entry.decidedAt;
  if (!base) return null;
  const offsets = entry.category === 'pre-release' ? RELEASE_OFFSETS : OFFSETS;
  return offsets.map((n) => addDays(base, n)).find((d) => d > fromDate) ?? null;
}

export function isDue(entry, today) {
  return entry.status === 'active' && entry.nextRecheck && entry.nextRecheck <= today;
}

async function checkRoblox(entry) {
  const current = await onRoblox(entry.name).catch(() => null);
  const name = current?.name ?? entry.name;
  const mediaMap = await codesMediaBatch([name]).catch(() => new Map());
  const media = mediaMap.get(name) ?? null;
  const r = await analyze(name, { media });
  const trendPositive = ['rising', 'rising-hold', 'high-stable'].includes(r.trends.shape);
  return {
    verdict: r.decision.decision.includes('放弃') ? `❌ ${r.decision.decision.replace(/^❌\s*/, '')}` : r.decision.decision,
    evidence: r.sub.guide.length > 0 || (media?.media?.length ?? 0) > 0 || trendPositive,
    ccu: current?.playing,
    trend: r.trends.shape,
    guideWords: r.sub.guide.length,
    note: r.decision.why,
  };
}

async function checkSteam(entry) {
  const r = await steamGate(entry.name);
  const verdict = {
    'tool-opportunity': '🟢 GO', 'watch-wiki-mature': '🟡 观察', 'watch-weak-demand': '🟡 观察',
    prerelease: '🌱 预发布', 'reject-generic': '❌ 放弃', 'reject-no-tool-demand': '❌ 放弃',
  }[r.verdict] ?? r.verdict;
  let ccu;
  if (r.release?.appid) {
    try {
      const d = await (await fetch(`https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${r.release.appid}`, { signal: AbortSignal.timeout(12_000) })).json();
      ccu = d.response?.player_count;
    } catch { /* CCU 只是补充，不挡闸门 */ }
  }
  return {
    verdict,
    evidence: r.toolHits.length > 0 || r.verdict === 'tool-opportunity',
    ccu,
    guideWords: r.toolHits.length,
    note: r.note.join('；') || `${r.toolHits.length} 条工具需求`,
  };
}

async function checkOther(entry) {
  const { stdout } = await exec(process.execPath, ['radar.mjs', 'check', entry.name], { cwd: ROOT, timeout: 180_000, maxBuffer: 4 << 20 });
  const line = stdout.split('\n').find((l) => /🟢 机会|🟡 观察|❌ /.test(l) && l.includes(entry.name));
  if (!line) throw new Error('其他平台复测没有返回有效判决');
  const verdict = line.includes('🟢') ? '🟢 GO' : line.includes('🟡') ? '🟡 观察' : '❌ 放弃';
  return { verdict, evidence: verdict === '🟢 GO', note: line.trim() };
}

const CHECK = { roblox: checkRoblox, steam: checkSteam, other: checkOther };

function readLedger() {
  try {
    const data = JSON.parse(readFileSync(LEDGER, 'utf8'));
    if (!Array.isArray(data.decisions)) throw new Error('缺 decisions 数组');
    return data;
  } catch (error) {
    throw new Error(`否决账本读取失败：${error.message}`, { cause: error });
  }
}

function renderReport(rows, today, meta) {
  const lines = [
    `# 否决候选复测 ${today}`, '',
    `到期 ${meta.due} 个 · 翻转 ${meta.flips} · 稳定 ${meta.stable} · 失败 ${meta.errors} · 每日上限 ${meta.limit}`, '',
    '> 翻转 ≠ 建站 GO；只表示需要重新做 SERP、实体数和竞品复核。结构型否决不在本表，只有人工重开才复测。', '',
  ];
  if (rows.length) {
    lines.push('| 结果 | 游戏 | 判决变化 | CCU | Trends | 攻略/工具词 | 下次复测 | 证据 |', '|---|---|---|---:|---|---:|---|---|');
    for (const r of rows) lines.push(`| ${r.outcome === 'flip' ? '🔄 翻转' : r.outcome === 'error' ? '⚠️ 失败' : '⚪ 稳定'} | ${r.name} | ${r.before} → ${r.after} | ${r.ccu ?? '—'} | ${r.trend ?? '—'} | ${r.guideWords ?? '—'} | ${r.nextRecheck ?? '停止（待人工）'} | ${String(r.note ?? '').replaceAll('|', '/').slice(0, 180)} |`);
  } else lines.push('今天没有到期候选。');
  return `${lines.join('\n')}\n`;
}

export async function runRejectionRecheck({ dryRun = false, notifyOnAlert = true, now = new Date(), limit = Number(process.env.REJECTION_RECHECK_LIMIT ?? 8) } = {}) {
  const today = ymd(now);
  const data = readLedger();
  // 新加进账本、还没算计划日的需求型候选自动排期；结构型保持 manual。
  for (const e of data.decisions) {
    // 老候选被人工重开时，原计划可能已全过期：立即复测一次，别静默跳过。
    if (e.status === 'active' && !e.nextRecheck) e.nextRecheck = nextScheduled(e, today) ?? today;
  }
  const due = data.decisions.filter((e) => isDue(e, today)).sort((a, b) => a.nextRecheck.localeCompare(b.nextRecheck)).slice(0, limit);
  const rows = [];
  for (const e of due) {
    const before = e.verdict ?? e.decidedVerdict ?? '❌';
    try {
      const r = await (CHECK[e.platform] ?? CHECK.other)(e);
      const outcome = isFlip(before, r.verdict, r.evidence) ? 'flip' : 'stable';
      e.verdict = r.verdict;
      e.lastChecked = today;
      e.history = [...(e.history ?? []), { date: today, from: before, to: r.verdict, outcome, ccu: r.ccu, trend: r.trend, guideWords: r.guideWords }].slice(-30);
      if (outcome === 'flip') {
        e.status = 'flipped';
        e.nextRecheck = null;
      } else {
        e.nextRecheck = nextScheduled(e, today);
        e.status = e.nextRecheck ? 'active' : 'closed';
      }
      rows.push({ name: e.name, before, after: r.verdict, outcome, ccu: r.ccu, trend: r.trend, guideWords: r.guideWords, note: r.note, nextRecheck: e.nextRecheck });
    } catch (error) {
      e.lastChecked = today;
      e.nextRecheck = addDays(today, 1);
      e.status = 'active';
      e.history = [...(e.history ?? []), { date: today, from: before, outcome: 'error', error: error.message.slice(0, 160) }].slice(-30);
      rows.push({ name: e.name, before, after: '复测失败', outcome: 'error', note: error.message, nextRecheck: e.nextRecheck });
    }
  }
  const flips = rows.filter((r) => r.outcome === 'flip');
  const meta = { due: due.length, flips: flips.length, stable: rows.filter((r) => r.outcome === 'stable').length, errors: rows.filter((r) => r.outcome === 'error').length, limit };
  const report = renderReport(rows, today, meta);
  if (!dryRun) {
    writeFileSync(LEDGER, `${JSON.stringify(data, null, 2)}\n`);
    writeFileSync(reportPath(`RADAR-NEGATIVE-${today}.md`), report);
    if (flips.length && notifyOnAlert) await notify('🔄 否决候选需求翻转', `${flips.map((r) => `${r.name}（${r.before} → ${r.after}）`).join('\n')}\n\n需要重新做 SERP / 实体 / 竞品复核，不自动等于建站 GO。\n报告：reports/negative/RADAR-NEGATIVE-${today}.md`);
  }
  return { rows, meta, report };
}

const IS_MAIN = import.meta.url === `file://${process.argv[1]}` || Boolean(process.argv[1]?.endsWith('rejection-recheck.mjs'));
if (IS_MAIN) {
  if (!existsSync(LEDGER)) throw new Error(`缺否决账本：${LEDGER}`);
  const dryRun = process.argv.includes('--dry-run');
  const r = await runRejectionRecheck({ dryRun });
  console.log(r.report);
}
