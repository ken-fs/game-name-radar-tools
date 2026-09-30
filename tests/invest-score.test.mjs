import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreInvest, gameplayLongTail, domainSlug, appIdFromCandidate } from '../lib/invest-score.mjs';

const NOW = Date.parse('2026-09-30T12:00:00Z');
const dom = (slug, taken) => ['com', 'net', 'wiki', 'xyz'].map((t) => ({ domain: `${slug}.${t}`, available: !taken.includes(t) }))
  .concat([{ domain: `${slug}wiki.com`, available: !taken.includes('wikicom') }, { domain: `${slug}guide.com`, available: !taken.includes('guidecom') }]);

function facts(overrides = {}) {
  return {
    game: 'Test Game', released: true, releaseDate: 'Sep 20, 2026', isFree: false, priceUsd: 19.99,
    tags: ['Life Sim', 'Farming Sim', 'Crafting', 'Fishing', 'RPG'], achievements: 80,
    ccu: 4000, ccuHistory: [{ t: '2026-09-28T12', ccu: 5000 }, { t: '2026-09-30T12', ccu: 4000 }],
    longTail: ['test game best fishing spot', 'test game how to get iron', 'test game romance options', 'test game money guide', 'test game all recipes'],
    domains: dom('testgame', []), wikis: [],
    ...overrides,
  };
}

test('open window + entity structure + paid game = go', () => {
  const r = scoreInvest(facts(), NOW);
  assert.equal(r.verdict, 'go');
  assert.ok(r.score >= 65);
});

test('Nivalis Nights case: squatted domains, no gameplay long-tail → not go', () => {
  const r = scoreInvest(facts({
    game: 'Nivalis Nights', releaseDate: 'Sep 29, 2026', longTail: [], ccu: 3599, ccuHistory: [{ t: '2026-09-30T12', ccu: 3599 }],
    domains: dom('nivalisnights', ['com', 'net', 'wiki', 'wikicom', 'guidecom']),
  }), NOW);
  assert.notEqual(r.verdict, 'go');
  assert.equal(r.dims.retention, 10, 'launch-week game gets neutral retention');
});

test('Fields of Mistria case: huge wiki caps go to watch even with strong demand', () => {
  const r = scoreInvest(facts({
    longTail: Array.from({ length: 30 }, (_, i) => `test game item ${i}`),
    domains: dom('testgame', ['com', 'net', 'wiki', 'xyz', 'wikicom', 'guidecom']),
    wikis: ['testgame.wiki.gg(2953页)'],
  }), NOW);
  assert.equal(r.verdict, 'watch');
});

test('NSFW tag vetoes regardless of score', () => {
  const r = scoreInvest(facts({ tags: [...facts().tags, 'Sexual Content'] }), NOW);
  assert.equal(r.verdict, 'skip');
  assert.equal(r.dims.adValue, 0);
});

test('unreleased entity-heavy paid game with open window = prelaunch', () => {
  const r = scoreInvest(facts({ released: false, releaseDate: 'Coming soon', longTail: [], ccu: null, ccuHistory: [] }), NOW);
  assert.equal(r.verdict, 'prelaunch');
});

test('retention decay is scored once history spans a day', () => {
  const r = scoreInvest(facts({ ccu: 800, ccuHistory: [{ t: '2026-09-28T12', ccu: 5000 }, { t: '2026-09-30T12', ccu: 800 }] }), NOW);
  assert.equal(r.dims.retention, 3);
});

test('gameplayLongTail drops launch meta queries', () => {
  const out = gameplayLongTail('Nivalis Nights', [
    'nivalis nights ps5', 'nivalis nights release date', 'nivalis nights game', 'nivalis nights romance options', 'how to get to trapani',
  ]);
  assert.deepEqual(out, ['nivalis nights romance options']);
});

test('helpers', () => {
  assert.equal(domainSlug('STAR WARS Zero Company™'), 'starwarszerocompany');
  assert.equal(appIdFromCandidate({ sources: [{ url: 'https://store.steampowered.com/app/1488490/Nivalis_Nights/?snr=1' }] }), '1488490');
});

test('wiki probe failure counts as unknown, not open (Scrap Mechanic case)', () => {
  const base = facts({ domains: dom('testgame', ['com', 'net']) });
  const ok = scoreInvest(base, NOW);
  const failed = scoreInvest({ ...base, wikiProbeFailed: ['fandom.com'] }, NOW);
  assert.equal(ok.dims.window - failed.dims.window, 4);
});

test('brand domain registered years before release = legacy ecosystem penalty', () => {
  const domains = dom('testgame', []).map((d) => (d.domain === 'testgame.com' ? { ...d, available: false, registered: '2015-03-01' } : d));
  const r = scoreInvest(facts({ domains }), NOW);
  assert.match(r.reasons.join(' '), /老生态/);
});
