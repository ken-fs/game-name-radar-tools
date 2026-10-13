import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chartSignals, compareRows, hitCell, inWindow, judgeCharts, parseMostPlayed, parseWeekly, releaseAge, renderReport } from '../lib/steam-charts-watch.mjs';
import { classifyToolDemand } from '../lib/tool-demand.mjs';

// ─── Steam 畅销 / 在玩榜（2026-10-13 加）───────────────────────────────────────

test('parseWeekly keeps last_week_rank null when the game was not on last week\'s chart', () => {
  const w = parseWeekly({ response: { start_date: 1790035200, ranks: [
    { rank: 12, appid: 4019220, last_week_rank: 89, consecutive_weeks: 2, item: { name: 'Dressmaker' } },
    { rank: 20, appid: 4019220 + 1, consecutive_weeks: 1, item: { name: 'New One' } },
  ] } });
  assert.equal(w.key, '2026-09-22');
  assert.deepEqual(w.ranks[0], { appid: 4019220, rank: 12, lastWeekRank: 89, weeks: 2, name: 'Dressmaker' });
  assert.equal(w.ranks[1].lastWeekRank, null);
  assert.equal(parseWeekly({ response: {} }), null);
});

test('parseMostPlayed reads rollup date and peak', () => {
  const m = parseMostPlayed({ response: { rollup_date: 1791763200, ranks: [{ rank: 9, appid: 1808500, last_week_rank: 52, peak_in_game: 152547 }] } });
  assert.equal(m.key, '2026-10-12');
  assert.deepEqual(m.ranks[0], { appid: 1808500, rank: 9, lastWeekRank: 52, peak: 152547 });
});

test('chartSignals: Dressmaker backtest — week 09-15 new entry, week 09-22 jump from #89', () => {
  const snaps = { '2026-09-08': { 730: 1, 570: 2 } };
  const w15 = chartSignals([{ appid: 4019220, rank: 89, lastWeekRank: null }, { appid: 730, rank: 1, lastWeekRank: 1 }], snaps, { key: '2026-09-15' });
  assert.deepEqual(w15.get(4019220), { rank: 89, prevRank: null, signal: 'new' });
  assert.equal(w15.has(730), false); // 常青游戏一直在榜上：没信号
  const w22 = chartSignals([{ appid: 4019220, rank: 12, lastWeekRank: 89 }], { ...snaps, '2026-09-15': { 4019220: 89 } }, { key: '2026-09-22' });
  assert.deepEqual(w22.get(4019220), { rank: 12, prevRank: 89, signal: 'jump' });
});

test('chartSignals: seen in the last 14 days = not new; small moves = no signal', () => {
  const snaps = { '2026-10-01': { 1: 40 }, '2026-10-10': { 2: 60 } };
  const s = chartSignals([{ appid: 1, rank: 35 }, { appid: 2, rank: 50 }, { appid: 3, rank: 70 }], snaps, { key: '2026-10-13' });
  assert.equal(s.has(1), false); // 12 天前在前 100，名次也没大动
  assert.equal(s.has(2), false); // 升了 10 名，不够 30
  assert.equal(s.get(3).signal, 'new');
  // 15 天前那次不算「前 14 天」
  assert.equal(chartSignals([{ appid: 9, rank: 5 }], { '2026-09-28': { 9: 5 }, '2026-10-12': { 1: 1 } }, { key: '2026-10-13' }).get(9).signal, 'new');
});

test('chartSignals: live chart first run (no snapshots, no API last-week rank) only builds a baseline', () => {
  assert.equal(chartSignals([{ appid: 1, rank: 3 }], {}, { key: '2026-10-13' }).size, 0);
});

test('chartSignals: API last-week rank >100 still counts as new to the top 100', () => {
  const s = chartSignals([{ appid: 632360, rank: 44, lastWeekRank: 149 }], {}, { key: '2026-10-12' });
  assert.deepEqual(s.get(632360), { rank: 44, prevRank: 149, signal: 'new' });
});

test('release window keeps fresh / upcoming-in-7-days games and drops evergreen ones', () => {
  assert.equal(releaseAge({ date: '2026-09-21' }, '2026-09-29'), 8);
  assert.equal(releaseAge({ date: null, text: 'Q4 2026' }, '2026-10-13'), null);
  assert.equal(inWindow(8), true);
  assert.equal(inWindow(-7), true);
  assert.equal(inWindow(-8), false);
  assert.equal(inWindow(46), false);
  assert.equal(inWindow(releaseAge({ date: '2012-08-21' }, '2026-10-13')), false); // CS2
  assert.equal(inWindow(null), false);
});

test('judgeCharts: 🟢 needs a top-50 rank and ≤30 days; else 🌱; out of window = null', () => {
  assert.equal(judgeCharts([{ rank: 12 }], 8), 'go');
  assert.equal(judgeCharts([{ rank: 33 }], -1), 'go'); // 预购冲榜，明天发售（Graveyard Keeper 2 那周）
  assert.equal(judgeCharts([{ rank: 89 }], 1), 'sprout');
  assert.equal(judgeCharts([{ rank: 12 }], 40), 'sprout');
  assert.equal(judgeCharts([{ rank: 1 }], 400), null);
  assert.equal(judgeCharts([], 3), null);
});

test('compareRows: more charts in the top 50 first, then best rank', () => {
  const a = { verdict: 'go', hits: [{ chart: 'weekly-de', rank: 9 }] };
  const b = { verdict: 'go', hits: [{ chart: 'weekly-global', rank: 12 }, { chart: 'weekly-us', rank: 10 }] };
  const c = { verdict: 'sprout', hits: [{ chart: 'weekly-jp', rank: 1 }] };
  assert.deepEqual([a, c, b].sort(compareRows), [b, a, c]);
});

test('renderReport rows start with the verdict label radar.mjs / radar-review look for', () => {
  const rows = [{ appid: 4019220, name: 'Dressmaker', verdict: 'go', isNewAlert: true, age: 8, release: { date: '2026-09-21' }, tags: ['Simulation'], also: [{ label: '在玩榜', rank: 70 }],
    hits: [{ label: '全球周畅销', chart: 'weekly-global', rank: 12, prevRank: 89, signal: 'jump' }], tool: { ok: true, count: 0, hits: [] }, invest: { verdict: 'watch', score: 63 } }];
  const md = renderReport(rows, { date: '2026-09-29', firstRun: false, charts: { 'weekly-global': '2026-09-22' }, chartCount: 8, errors: [], outOfWindow: 3, seconds: 5, nrd: { available: false, byName: {}, dates: [] } });
  const line = md.split('\n').find((l) => l.startsWith('| 🟢 冲榜 🆕'));
  assert.ok(line.includes('[Dressmaker](https://store.steampowered.com/app/4019220/)'));
  assert.ok(line.includes('全球周畅销 #12（⬆️ 从 #89）'));
  assert.ok(line.includes('🟡 观察 63'));
  assert.match(md, /榜单拿到 1\/8 个/);
  assert.equal(hitCell({ label: '美国周畅销', rank: 13, prevRank: 166, signal: 'new' }), '美国周畅销 #13（🆕，上周 #166）');
});

test('tool demand ignores "out of stock" (steelbook / controller shortages are not tools)', () => {
  assert.deepEqual(classifyToolDemand('Control Resonant', ['control resonant steelbook out of stock', 'control resonant stock']), ['control resonant stock']);
});
