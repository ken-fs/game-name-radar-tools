import assert from 'node:assert/strict';
import { test } from 'node:test';

import { analyzeSerp, gapCutoff, isNative, localDemand, MARKETS, parseDate, serpGapNote } from '../lib/serp-gap.mjs';

const NOW = Date.UTC(2026, 9, 20);
const m = (cc) => MARKETS.find((x) => x.cc === cc);
const day = (s) => new Date(s).toISOString().slice(0, 10);

test('parseDate reads the local formats treg returns', () => {
  assert.equal(day(parseDate('13.07.2025', NOW)), '2025-07-13');
  assert.equal(day(parseDate('Jul 13, 2025', NOW)), '2025-07-13');
  assert.equal(day(parseDate('2025年7月13日', NOW)), '2025-07-13');
  assert.equal(day(parseDate('2025. 7. 13.', NOW)), '2025-07-13');
  assert.equal(day(parseDate('vor 1 Jahr', NOW)), '2025-10-20');
  assert.equal(day(parseDate('1 settimana fa', NOW)), '2026-10-13'); // 「settimana」里有 an，不能当成年
  assert.equal(day(parseDate('3일 전', NOW)), '2026-10-17');
  assert.equal(parseDate('', NOW), null);
});

test('isNative: script for ja/ko, function words or URL for EU languages', () => {
  assert.equal(isNative({ title: 'Grow a Garden コード一覧', url: 'https://x.jp/a' }, m('jp')), true);
  assert.equal(isNative({ title: 'Grow a Garden codes', url: 'https://x.com/a' }, m('jp')), false);
  assert.equal(isNative({ title: 'Grow A Garden-Codes - Theria-Spiele', url: 'https://theriagames.com/de/guide/x/' }, m('de')), true);
  assert.equal(isNative({ title: 'Alle aktuellen Codes', snippet: 'Hier sind die neue Codes für das Spiel und wie ihr sie einlöst', url: 'https://x.com/a' }, m('de')), true);
  assert.equal(isNative({ title: 'All Grow a Garden codes', snippet: 'Here is how to redeem the codes in the game', url: 'https://x.com/a' }, m('de')), false);
});

test('analyzeSerp skips videos and counts stale pages before the cutoff', () => {
  const results = [
    { domain: 'youtube.com', title: 'codes', date: 'vor 1 Jahr' },
    { domain: 'a.com', title: 'Codes', date: '01.01.2026' },
    { domain: 'b.com', title: 'Codes (October 2026)', date: '' },
    { domain: 'c.com', title: 'Codes 2025', date: '' },
    { domain: 'd.com', title: 'Codes', date: '3 days ago' },
  ];
  const r = analyzeSerp(results, { updatedAt: NOW - 86400_000, now: NOW });
  assert.deepEqual({ pages: r.pages, dated: r.dated, stale: r.stale }, { pages: 4, dated: 4, stale: 2 });
  // Roblox 的 updated 几乎天天变：分界不早于 30 天前
  assert.equal(gapCutoff(NOW - 86400_000, NOW), NOW - 30 * 86400_000);
  assert.equal(gapCutoff(NOW - 90 * 86400_000, NOW), NOW - 90 * 86400_000);
});

test('localDemand needs the game name and a local word', () => {
  const c = ['grow a garden codici', 'grow a garden 2 codici', 'grow a garden codes', 'codici roblox'];
  assert.equal(localDemand('Grow a Garden', c, m('it')), 2);
  assert.equal(localDemand('Grow a Garden', ['grow a garden コード'], m('jp')), 1);
});

test('serpGapNote only speaks when there is a gap', () => {
  const base = { ok: true, at: NOW, updatedAt: NOW - 86400_000, us: { stale: 1, dated: 7 }, gaps: [], outdated: false };
  assert.equal(serpGapNote(base), '');
  assert.match(serpGapNote({ ...base, gaps: ['it', 'jp'] }), /🌐 语言空位 意日/);
  assert.match(serpGapNote({ ...base, outdated: true, us: { stale: 6, dated: 7 } }), /🕰️ 美国前 10 有 6\/7 页早于30 天前/);
  assert.equal(serpGapNote({ ok: false }), 'SERP 空位 查询失败');
});
