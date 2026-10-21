// 站型信号（2026-10-13 加）：🧮 工具需求 + codes 媒体进场数
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyToolDemand, toolDemand, toolDemandNote } from '../lib/tool-demand.mjs';
import { classifyMedia, mediaSlug, probeMedia } from '../lib/codes-media.mjs';
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

test('codes media: 0–1 = open, 2 = mixed, ≥3 = closed', () => {
  assert.equal(classifyMedia([]).verdict, 'open');
  assert.equal(classifyMedia(['urgametips.com']).verdict, 'open');
  assert.equal(classifyMedia(['beebom.com', 'gamerant.com']).verdict, 'mixed');
  assert.match(classifyMedia(['beebom.com', 'gamerant.com', 'pcgamesn.com']).label, /⛔ codes 媒体 3 家/);
});

test('codes media: blocked sites are not counted as missing (2026-10-20)', () => {
  const r = classifyMedia([], ['progameguides.com', 'tryhardguides.com']);
  assert.equal(r.verdict, 'unverified');
  assert.match(r.label, /2 家被挡/);
  const partly = classifyMedia(['beebom.com'], ['tryhardguides.com']);
  assert.equal(partly.verdict, 'open');
  assert.match(partly.label, /另有 1 家被挡未计/);
  assert.equal(classifyMedia(['beebom.com', 'gamerant.com', 'pcgamesn.com'], ['tryhardguides.com']).verdict, 'closed');
});

test('probeMedia treats 403 as blocked, not as "no page"', async () => {
  const r = await probeMedia('Pa Deliber', {
    exists: async (u) => (u.includes('beebom') || u.includes('thegamer') ? 'blocked' : null),
  });
  assert.equal(r.verdict, 'unverified');
  assert.deepEqual(r.blocked, ['beebom.com', 'thegamer.com']);
});

test('mediaSlug drops apostrophes and tags punctuation', () => {
  assert.equal(mediaSlug('Build An Ant Empire'), 'build-an-ant-empire');
  assert.equal(mediaSlug("Don't Be Late For School!"), 'dont-be-late-for-school');
});

test('probeMedia counts a domain once even when two URL shapes hit', async () => {
  const live = new Set(['https://www.pockettactics.com/deep-fishing-codes', 'https://www.pockettactics.com/deep-fishing/codes', 'https://beebom.com/deep-fishing-codes/']);
  const r = await probeMedia('Deep Fishing', { exists: async (u) => live.has(u) });
  assert.deepEqual(r.media, ['beebom.com', 'pockettactics.com']);
  assert.equal(r.verdict, 'mixed');
});

test('probeMedia throws when every request failed (network down ≠ 0 media)', async () => {
  await assert.rejects(probeMedia('Deep Fishing', { exists: async () => null }));
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

test('siteShapeSignals skips codes media for Steam (paid games have no codes ecosystem)', async () => {
  const items = [{ kind: 'steam', name: 'Some Steam Game', text: '- **Steam** Some Steam Game' }];
  let codesCalled = false;
  const out = await siteShapeSignals(items, {
    tool: async () => ({ ok: true, count: 0, tag: false, hits: [] }),
    codes: async () => { codesCalled = true; return new Map(); },
  });
  assert.equal(codesCalled, false, 'codes 不该为 Steam 花额度');
  assert.deepEqual(out.get(items[0]), []);
  assert.equal(items[0].shape.codes, undefined);
  assert.deepEqual(items[0].shape.tool, { ok: true, count: 0, tag: false, hits: [] });
});
