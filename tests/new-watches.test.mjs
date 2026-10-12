import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildPool, describeRelease, followerStats, judgeFollow, parseMemberCount, parseReleaseText, parseSearchHtml } from '../lib/steam-follow-watch.mjs';
import { buildSeeds, diffDay, extractName, FAMILIES } from '../lib/suggest-diff-watch.mjs';
import { matchDomains, nameVariants, nrdNote } from '../lib/nrd.mjs';
import { isGenericWikiName, isWikiContent, pickWikiRisers } from '../lib/meme-game-watch.mjs';

// ─── Steam 关注者 ────────────────────────────────────────────────────────────

test('parseMemberCount reads the groupDetails count, not the paging one', () => {
  const xml = '<memberList><groupDetails><groupName>EmberQuest</groupName><memberCount>47</memberCount><membersOnline>17</membersOnline></groupDetails><memberCount>52</memberCount></memberList>';
  assert.equal(parseMemberCount(xml), 47);
  assert.equal(parseMemberCount('<html>error</html>'), null);
});

test('parseReleaseText handles both Steam date orders and skips vague dates', () => {
  assert.equal(parseReleaseText('Oct 15, 2026'), '2026-10-15');
  assert.equal(parseReleaseText('9 Oct, 2026'), '2026-10-09');
  assert.equal(parseReleaseText('Coming soon'), null);
  assert.equal(parseReleaseText('Q4 2026'), null);
});

test('parseSearchHtml pulls appid / title / release from infinite=1 html', () => {
  const html = '<a data-ds-appid="5328820" class="search_result_row"><span class="title">EmberQuest &amp; Co</span><div class="search_released responsive_secondrow">Oct 15, 2026</div></a>' +
    '<a data-ds-appid="111,222"><span class="title">Bundle</span><div class="search_released">Coming soon</div></a>';
  assert.deepEqual(parseSearchHtml(html), [
    { appid: 5328820, name: 'EmberQuest & Co', releaseText: 'Oct 15, 2026' },
    { appid: 111, name: 'Bundle', releaseText: 'Coming soon' },
  ]);
});

test('describeRelease only treats full dates as exact', () => {
  assert.deepEqual(describeRelease({ steam_release_date: 1792083600, is_coming_soon: true, coming_soon_display: 'date_full' }), { date: '2026-10-15', text: '2026-10-15', comingSoon: true });
  assert.equal(describeRelease({ steam_release_date: 1798675200, is_coming_soon: true, coming_soon_display: 'date_quarter' }).date, null);
  assert.equal(describeRelease({ is_coming_soon: true, custom_release_date_message: 'Coming soon', coming_soon_display: 'text_comingsoon' }).text, 'Coming soon');
});

test('followerStats: daily delta, real 7-day growth and estimated growth', () => {
  assert.equal(followerStats([{ date: '2026-10-12', followers: 1622 }]).daily, null);
  const week = followerStats([
    { date: '2026-10-05', followers: 1000 },
    { date: '2026-10-11', followers: 1500 },
    { date: '2026-10-12', followers: 1600 },
  ]);
  assert.equal(week.daily, 100);
  assert.equal(week.growth7, 0.6);
  assert.equal(week.estimated, false);
  const short = followerStats([
    { date: '2026-10-10', followers: 1000 },
    { date: '2026-10-12', followers: 1100 },
  ]);
  assert.equal(short.daily, 50);
  assert.equal(short.growth7, 0.35); // 10% / 2 天 → 折算 7 天
  assert.equal(short.estimated, true);
});

test('judgeFollow thresholds', () => {
  assert.equal(judgeFollow({ followers: 1622, daily: null, growth7: null, spanDays: 0 }), 'new');
  assert.equal(judgeFollow({ followers: 8000, daily: 150, growth7: 0.25, spanDays: 7 }), 'go');
  assert.equal(judgeFollow({ followers: 1800, daily: 40, growth7: 0.8, spanDays: 3 }), 'sprout');
  assert.equal(judgeFollow({ followers: 450000, daily: 2000, growth7: 0.03, spanDays: 7 }), 'big');
  assert.equal(judgeFollow({ followers: 20000, daily: 40, growth7: 0.02, spanDays: 7 }), 'rising');
  assert.equal(judgeFollow({ followers: 20000, daily: 5, growth7: 0.01, spanDays: 7 }), 'flat');
  // 只有 1 天曲线不下判决（单日抖动）
  assert.equal(judgeFollow({ followers: 8000, daily: 500, growth7: 1, spanDays: 1 }), 'new');
});

test('buildPool keeps own sites and fills each source by quota', () => {
  const entries = [
    { appid: 1, own: 'volatiles' },
    ...Array.from({ length: 10 }, (_, i) => ({ appid: 100 + i, trendRank: i + 1 })),
    ...Array.from({ length: 10 }, (_, i) => ({ appid: 200 + i, soonRank: i + 1 })),
    { appid: 300, newRank: 1 },
  ];
  const pool = buildPool(entries, 7, { trendRank: 3, soonRank: 2, newRank: 1 });
  const ids = pool.map((e) => e.appid);
  assert.equal(pool.length, 7);
  assert.equal(buildPool(entries, 8, { trendRank: 3, soonRank: 2, newRank: 1 }).length, 8); // 剩余名额按名次补
  assert.ok(ids.includes(1));
  assert.ok(ids.includes(300));
  assert.deepEqual(ids.filter((id) => id >= 200 && id < 300), [200, 201]);
});

// ─── 联想词差分 ──────────────────────────────────────────────────────────────

const codes = FAMILIES.find((f) => f.id === 'codes');
const tier = FAMILIES.find((f) => f.id === 'tier');
const anime = FAMILIES.find((f) => f.id === 'robloxanime');

test('extractName strips the prefix and trailing qualifiers', () => {
  assert.equal(extractName('codes for huss valley roblox', codes), 'huss valley');
  assert.equal(extractName('codes for steal a brainrot roblox 2026', codes), 'steal a brainrot');
  assert.equal(extractName('roblox anime apocalypse codes', anime), 'anime apocalypse');
  assert.equal(extractName('tier list for anime zero', tier), 'anime zero');
  assert.equal(extractName('codes for robux', codes), '');
  assert.equal(extractName('something else', codes), '');
});

test('buildSeeds stays within a few hundred requests', () => {
  const seeds = buildSeeds();
  assert.ok(seeds.length >= 200 && seeds.length <= 400, `seeds=${seeds.length}`);
  assert.ok(seeds.some((s) => s.query === 'codes for ka'));
});

test('diffDay: baseline day marks nothing new, later days surface fresh names', () => {
  const day1 = [
    { family: 'codes', query: 'codes for a', suggestions: ['codes for anime zero', 'codes for anime expeditions'] },
    { family: 'tier', query: 'tier list for a', suggestions: ['tier list for anime zero'] },
  ];
  const r1 = diffDay({}, day1, '2026-10-12');
  assert.equal(r1.baseline, true);
  assert.ok(r1.rows.every((r) => r.verdict === 'old'));

  const state = { ...r1.state, lastRun: '2026-10-12T05:00:00Z' };
  const day2 = [
    { family: 'codes', query: 'codes for a', suggestions: ['codes for anime zero', 'codes for anime mysterious roblox'] },
    { family: 'tier', query: 'tier list for a', suggestions: ['tier list for anime zero', 'tier list for anime mysterious'] },
    { family: 'wiki', query: 'wiki for a', suggestions: ['wiki for all mankind season 6'] },
    { family: 'build', query: 'best build for a', suggestions: ['best build for astarion'] },
  ];
  const r2 = diffDay(state, day2, '2026-10-13');
  const by = Object.fromEntries(r2.rows.map((r) => [r.name, r]));
  assert.equal(by['anime mysterious'].verdict, 'go'); // 两类攻略意图同一天冒出
  assert.equal(by['anime zero'].verdict, 'old'); // 基线里就有
  assert.equal(by['astarion'].verdict, 'new'); // 只有一类
  assert.equal(by['all mankind season 6'].verdict, 'nongame');
  assert.ok(r2.newSuggestions.some((s) => s.text === 'codes for anime mysterious roblox'));

  // 第三天只在一类里出现，但连续两天 → 🟢
  const r3 = diffDay({ ...r2.state, lastRun: 'x' }, [{ family: 'build', query: 'best build for a', suggestions: ['best build for astarion'] }], '2026-10-14');
  assert.equal(r3.rows.find((r) => r.name === 'astarion').verdict, 'go');
});

// ─── 新注册域名 ──────────────────────────────────────────────────────────────

test('nameVariants / matchDomains', () => {
  assert.deepEqual(nameVariants('AION'), []); // 太短
  assert.deepEqual(nameVariants('STAR WARS: Galactic Racer™'), ['starwarsgalacticracer', 'galacticracer']);
  assert.deepEqual(nameVariants('Probably Stolen - Cyberpunk Shopkeeper Sim'), ['probablystolencyberpunkshopkeepersim', 'probablystolen']);
  assert.deepEqual(matchDomains(['volatiles.wiki', 'volatile.shop', 'play-volatiles.com'], 'Volatiles'), ['volatiles.wiki', 'play-volatiles.com']);
  assert.equal(matchDomains(['x.com'], 'abc'), null);
});

test('nrdNote warns when peers are registering', () => {
  assert.equal(nrdNote({ count: 0, samples: [] }), '近 3 天 0 个新域名');
  assert.match(nrdNote({ count: 5, samples: ['aion2data.com', 'aion2cn.club'] }), /⚠️ 近 3 天 5 个新域名（同行在抢）：aion2data\.com/);
  assert.match(nrdNote(null), /不统计/);
});

// ─── Wikipedia 热门 ─────────────────────────────────────────────────────────

test('isWikiContent drops main pages and namespaces in every language', () => {
  for (const a of ['Main_Page', 'Special:Search', 'Wikipedia:Featured_pictures', 'Spezial:Suche', 'メインページ', '特別:検索', '특수:검색', 'Deaths_in_2026', 'List_of_equations']) assert.equal(isWikiContent(a), false, a);
  for (const a of ['Money_in_the_Bank_(2026)', 'Shutter_Island', 'Avengers:_Doomsday', 'VIVANT']) assert.equal(isWikiContent(a), true, a);
});

test('isGenericWikiName drops plain words and disambiguated single words', () => {
  assert.equal(isGenericWikiName('Animals_(2026_film)', 'Animals'), true);
  assert.equal(isGenericWikiName('Animales_(película)', 'Animales'), true);
  assert.equal(isGenericWikiName('Sprunki', 'Sprunki'), false);
  assert.equal(isGenericWikiName('Shutter_Island', 'Shutter Island'), false);
  assert.equal(isGenericWikiName('松本孝弘', '松本孝弘'), false);
});

test('pickWikiRisers: new top-200 entries and 3x spikes, not evergreen pages', () => {
  const evergreen = Array.from({ length: 14 }, () => [['Main_Page', 9e6], ['Taylor_Swift', 50000], ['Old_Show', 900]]);
  const today = [['Main_Page', 9e6], ['Taylor_Swift', 52000], ['New_Meme', 30000], ['Old_Show', 4000]];
  const risers = pickWikiRisers(today, evergreen, { top: 2, spike: 3, limit: 5 });
  const names = risers.map((r) => r.article);
  assert.ok(names.includes('New_Meme')); // 新进前 2
  assert.ok(names.includes('Old_Show')); // 900 → 4000 = ×4.4
  assert.ok(!names.includes('Taylor_Swift')); // 天天在前 200
  assert.ok(!names.includes('Main_Page'));
});
