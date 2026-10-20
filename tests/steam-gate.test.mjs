import test from 'node:test';
import assert from 'node:assert/strict';

import { prereleaseOverride } from '../lib/steam-gate.mjs';

// 2026-10-20 回归：Frostrail（50 万愿望单 + 生存合成品类）被「无工具需求」判 ❌。
// 预发布游戏的 autocomplete 天然只有 info 意图（demo / release date / playtest），
// calculator / value list 要等上线才长 → 未发售不能按工具需求判死。

const unreleased = { appid: 3517740, comingSoon: true, date: 'Q4 2026' };
const released = { appid: 1062520, comingSoon: false, date: 'Apr 22, 2025' };

test('未发售 + 无工具需求 → 降级为 prerelease，不判死', () => {
  const r = prereleaseOverride('reject-no-tool-demand', unreleased);
  assert.equal(r.verdict, 'prerelease');
  assert.match(r.note, /Q4 2026/);
  assert.match(r.note, /appid 3517740/);
});

test('未发售 + 工具机会 → 保留原判决，只加提醒', () => {
  const r = prereleaseOverride('tool-opportunity', unreleased);
  assert.equal(r.verdict, 'tool-opportunity');
  assert.match(r.note, /还会长/);
});

test('未发售 + 工具需求弱 → 保留 watch-weak-demand', () => {
  assert.equal(prereleaseOverride('watch-weak-demand', unreleased).verdict, 'watch-weak-demand');
});

test('未发售但名字通用 → 硬否决不受影响', () => {
  assert.equal(prereleaseOverride('reject-generic', unreleased), null);
});

test('已发售 → 不介入', () => {
  assert.equal(prereleaseOverride('reject-no-tool-demand', released), null);
});

test('查不到发售信息（null）→ 不介入', () => {
  assert.equal(prereleaseOverride('reject-no-tool-demand', null), null);
  assert.equal(prereleaseOverride('reject-no-tool-demand', undefined), null);
});
