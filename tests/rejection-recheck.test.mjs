import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isDue, isFlip, nextScheduled, verdictRank } from '../lib/rejection-recheck.mjs';

test('需求型否决按 +3/+7/+14/+30 排期，结束后关闭', () => {
  const e = { category: 'demand', decidedAt: '2026-10-01' };
  assert.equal(nextScheduled(e, '2026-10-01'), '2026-10-04');
  assert.equal(nextScheduled(e, '2026-10-04'), '2026-10-08');
  assert.equal(nextScheduled(e, '2026-10-08'), '2026-10-15');
  assert.equal(nextScheduled(e, '2026-10-15'), '2026-10-31');
  assert.equal(nextScheduled(e, '2026-10-31'), null);
});

test('预发布按发售 +3/+7/+14，而不是按决定日', () => {
  const e = { category: 'pre-release', decidedAt: '2026-10-01', releaseDate: '2026-11-10' };
  assert.equal(nextScheduled(e, '2026-10-30'), '2026-11-13');
  assert.equal(nextScheduled(e, '2026-11-13'), '2026-11-17');
  assert.equal(nextScheduled(e, '2026-11-17'), '2026-11-24');
  assert.equal(nextScheduled(e, '2026-11-24'), null);
});

test('只有 active 且到期才复测；manual / flipped 不自动跑', () => {
  assert.equal(isDue({ status: 'active', nextRecheck: '2026-10-30' }, '2026-10-30'), true);
  assert.equal(isDue({ status: 'active', nextRecheck: '2026-10-31' }, '2026-10-30'), false);
  assert.equal(isDue({ status: 'manual', nextRecheck: '2026-10-30' }, '2026-10-30'), false);
  assert.equal(isDue({ status: 'flipped', nextRecheck: null }, '2026-10-30'), false);
});

test('判决上升且有需求证据才翻转；无证据的观察不算', () => {
  assert.equal(verdictRank('❌'), 0);
  assert.equal(verdictRank('🟡 观察'), 1);
  assert.equal(verdictRank('🟢 GO'), 2);
  assert.equal(isFlip('❌', '🟡 观察', true), true);
  assert.equal(isFlip('❌', '🟡 观察', false), false);
  assert.equal(isFlip('🟡 观察', '🟢 GO', true), true);
  assert.equal(isFlip('🟡 观察', '🟡 观察', true), false);
});
