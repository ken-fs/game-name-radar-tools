// 判决记录（2026-10-13 加）：「今天最值得看」每条按固定字段写 data/verdict-log.jsonl
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { num, toRecord, writeVerdictLog } from '../lib/verdict-log.mjs';

test('num reads the report formats and leaves unknowns out', () => {
  assert.equal(num('12.3K'), 12300);
  assert.equal(num('1,234'), 1234);
  assert.equal(num('35x'), 35);
  assert.equal(num('🟢 74'), 74);
  assert.equal(num('-'), undefined);
  assert.equal(num(null), undefined);
});

test('record keeps only signals that exist, plus raw site-shape results', () => {
  const r = toRecord({
    kind: 'roblox', line: 'roblox-demand', name: 'Pets Universe', text: '- **Roblox** Pets Universe：🟢 GO（…）',
    data: { verdict: '🟢 GO', signals: { ccu: 5205, growthX: 7.2, ytChannels: undefined } },
    shape: { tool: { ok: true, count: 3 }, codes: { verdict: 'window', media: [] } },
  }, { date: '2026-10-13', nrd: { available: true, byName: { 'Pets Universe': 2 } } });
  assert.deepEqual(r.signals, { ccu: 5205, growthX: 7.2 });
  assert.equal(r.nrd3d, 2);
  assert.deepEqual(r.toolDemand, { ok: true, count: 3 });
  assert.deepEqual(r.codesMedia, { verdict: 'window', n: 0 });
  assert.equal(r.text.startsWith('**Roblox**'), true);
});

test('rerunning the same day overwrites instead of duplicating', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'vlog-')), 'v.jsonl');
  const item = (ccu) => ({ line: 'roblox-demand', name: 'Drop a Fruit', data: { verdict: '🟢', signals: { ccu } } });
  writeVerdictLog([item(1000)], { date: '2026-10-13', file });
  writeVerdictLog([item(3000)], { date: '2026-10-13', file });
  writeVerdictLog([item(5000)], { date: '2026-10-14', file });
  const rows = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => [r.date, r.signals.ccu]), [['2026-10-13', 3000], ['2026-10-14', 5000]]);
});
