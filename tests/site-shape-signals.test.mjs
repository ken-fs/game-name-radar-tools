// 站型信号（2026-10-13 加）：🧮 工具需求 + codes 媒体进场数
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyToolDemand, toolDemand, toolDemandNote } from '../lib/tool-demand.mjs';
import { classifyCodesSerp, titleMentions } from '../lib/codes-media.mjs';
import { scoreInvest } from '../lib/invest-score.mjs';
import { siteShapeSignals } from '../radar.mjs';

test('tool demand only counts completions that carry the game name and tool intent', () => {
  const hits = classifyToolDemand('Grow a Garden', [
    'grow a garden values', 'grow a garden value calculator', 'grow a garden stock notifier', 'grow a garden trading discord',
    'grow a garden update', 'how to grow a good garden', 'grow a garden trading cards',
  ]);
  assert.deepEqual(hits, ['grow a garden values', 'grow a garden value calculator', 'grow a garden stock notifier', 'grow a garden trading discord']);
});

test('tool demand ignores spell-corrected other entities (Pets Universe → pet universe price list)', () => {
  assert.deepEqual(classifyToolDemand('Pets Universe', ['pet universe price list', 'pet universe trading doha', 'flyff universe pet calculator']), []);
});

test('tool demand: Steam meta queries are not tools', () => {
  assert.deepEqual(classifyToolDemand('Megabonk', ['megabonk trading cards', 'megabonk worth it', 'megabonk in stock']), []);
});

test('tool demand marks all-failed lookups as not ok instead of zero', async () => {
  const r = await toolDemand('Some Game', { cache: false, fetcher: async () => { throw new Error('boom'); } });
  assert.equal(r.ok, false);
  assert.equal(toolDemandNote(r), '工具需求 查询失败');
});

test('codes SERP: fuzzy results about other games = mismatch, not 0 media', () => {
  const r = classifyCodesSerp('Pets Universe', [
    { domain: 'urgametips.com', title: 'Clicking Universe Codes (October 2026)' },
    { domain: 'youtube.com', title: 'ALL NEW Roblox Pet Catchers Codes!' },
    { domain: 'petsuniverse.wiki', title: 'Latest Pets Universe Codes: Boost Your Game Today (2026)' },
  ]);
  assert.equal(r.verdict, 'mismatch');
  assert.deepEqual(r.media, []);
});

test('codes SERP: ≥3 media covering the game = closed', () => {
  const rows = ['gamerant.com', 'www.beebom.com', 'ign.com', 'youtube.com'].map((domain) => ({ domain, title: 'Grow a Garden Codes (October 2026)' }));
  rows.push({ domain: 'pcgamesn.com', title: 'Garden Horizons codes' }); // 讲别的游戏的媒体不算
  const r = classifyCodesSerp('Grow a Garden', rows);
  assert.equal(r.verdict, 'closed');
  assert.deepEqual(r.media, ['gamerant.com', 'beebom.com', 'ign.com']);
  assert.match(r.label, /⛔ codes 媒体 3 家/);
});

test('codes SERP: 0–1 media = open, 2 = mixed', () => {
  const t = 'Command an Army Codes';
  assert.equal(classifyCodesSerp('Command an Army', ['youtube.com', 'reddit.com', 'beebom.com'].map((domain) => ({ domain, title: t }))).verdict, 'open');
  assert.equal(classifyCodesSerp('Command an Army', ['youtube.com', 'ign.com', 'beebom.com'].map((domain) => ({ domain, title: t }))).verdict, 'mixed');
});

test('titleMentions normalizes punctuation and spacing', () => {
  assert.ok(titleMentions('Pets Universe!', 'Pets Universe codes'));
  assert.ok(titleMentions('Blox Fruits', 'BloxFruits Codes Wiki'));
  assert.ok(!titleMentions('Fisch', 'Fish It codes'));
});

test('invest score: 🧮 tool demand adds to structure', () => {
  const base = { game: 'Test Game', released: true, releaseDate: 'Sep 20, 2026', priceUsd: 19.99, tags: ['RPG'], achievements: 0, ccu: 100, ccuHistory: [], longTail: [], domains: [], wikis: [] };
  const without = scoreInvest(base);
  const withTool = scoreInvest({ ...base, toolDemand: { ok: true, count: 4, tag: true, hits: ['test game values', 'test game calculator'] } });
  assert.equal(withTool.dims.structure - without.dims.structure, 5);
  assert.equal(withTool.toolTag, true);
});

test('siteShapeSignals never throws and marks failures per item', async () => {
  const items = [
    { kind: 'roblox', name: 'A', text: '- **Roblox** A' },
    { kind: 'meme', name: 'B', text: '- **梗** B' },
  ];
  const out = await siteShapeSignals(items, {
    tool: async () => { throw new Error('x'); },
    codes: async () => { throw new Error('y'); },
  });
  assert.deepEqual(out.get(items[0]), ['工具需求 查询失败', 'codes 媒体 查询失败']);
  assert.equal(out.has(items[1]), false, 'meme / playable lines are skipped');
});
