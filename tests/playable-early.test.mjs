import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  BIG_IP,
  assessOpenSource,
  chooseLinkedRepo,
  compositeSMNLC,
  extractRepoUrls,
  ipRisk,
  meansFromTimeline,
  mergeDirectoryCandidates,
  probePriority,
  scoreCompetition,
  selectProbeCandidates,
  monetizationPaths,
  parseAllTheDlesHome,
  parseAllTheDlesNew,
  parseEmbedPolicy,
  parseItchNewest,
  parseNewgroundsTop,
  trendsQueryFor,
  pickSearchRepo,
  renderEarlySection,
  runEarlyPlayableWatch,
  scoreEarly,
} from '../lib/playable-early-watch.mjs';

const NOW = Date.parse('2026-10-31T12:00:00Z');

test('SMNLC composite inverts C and matches the peer Tree Appreciator dims', () => {
  assert.equal(compositeSMNLC({ S: 6.5, M: 7.5, N: 8.5, L: 8, C: 2 }).toFixed(2), '7.70');
  assert.equal(compositeSMNLC({ S: 6, M: 7.5, N: 7.5, L: 8.5, C: 3.5 }).toFixed(2), '7.20');
});

test('embed policy: open headers vs DENY + frame-ancestors none', () => {
  const open = parseEmbedPolicy({});
  assert.equal(open.deny, false);
  assert.equal(open.linkability, 8.5);
  const blocked = parseEmbedPolicy({
    xFrameOptions: 'DENY',
    contentSecurityPolicy: "default-src 'self'; frame-ancestors 'none'; script-src 'self'",
  });
  assert.equal(blocked.deny, true);
  assert.equal(blocked.linkability, 5);
  assert.match(blocked.note, /XFO DENY/);
  assert.match(blocked.note, /frame-ancestors none/);
});

test('three monetization paths stay distinct and open-source does not become a green verdict', () => {
  const blocked = parseEmbedPolicy({ xFrameOptions: 'DENY', contentSecurityPolicy: "frame-ancestors 'none'" });
  const oss = assessOpenSource({
    repoUrl: 'https://github.com/acme/oss-game',
    license: 'Apache-2.0',
    language: 'HTML',
    rootFiles: ['index.html'],
    description: 'browser daily game',
  });
  const paths = monetizationPaths({ embed: blocked, oss });
  assert.equal(paths.embed.open, false);
  assert.match(paths.embed.label, /不可嵌/);
  assert.equal(paths.content.role, 'primary');
  assert.match(paths.content.label, /答案\/归档/);
  assert.equal(paths.oss.deployable, true);
  assert.match(paths.oss.label, /优先/);
  assert.match(paths.oss.label, /acme\/oss-game/);
  assert.match(paths.oss.label, /Apache-2\.0/);

  const unknownLicense = assessOpenSource({ repoUrl: 'https://github.com/acme/oss-game', rootFiles: ['index.html'] });
  assert.equal(unknownLicense.deployable, false);
  assert.match(unknownLicense.label, /许可证不明/);
  assert.equal(assessOpenSource({}).label, '无公开仓库');

  const scored = scoreEarly({
    name: 'Oss Game',
    weeklyRank: 4,
    launchedAt: '2026-10-20',
    embed: blocked,
    oss,
    social: { measured: true, redditPosts7d: 0, mediaMentions: 0 },
    competition: { c: 3 },
  }, NOW);
  assert.notEqual(scored.verdict, 'go');
  assert.equal(scored.tag, 'early / social');
  assert.equal(scored.paths.content.role, 'primary');
  assert.equal(scored.paths.oss.deployable, true);
});

test('weak Trends still surfaces an early/social row and never a portal green', () => {
  const row = scoreEarly({
    name: 'Gazillion',
    weeklyRank: 4,
    launchedAt: '2026-10-23',
    blurb: 'daily history year range',
    trends7: 0.6,
    trends30: 0.4,
    embed: parseEmbedPolicy({}),
    oss: assessOpenSource({}),
    social: { measured: true, redditPosts7d: 0, mediaMentions: 0 },
    competition: { c: 3.5 },
    lists: ['weekly-hot'],
  }, NOW);
  assert.equal(row.verdict, 'early');
  assert.equal(row.paths.embed.open, true);
  assert.equal(row.paths.content.role, 'fallback');
  assert.match(row.label, /早期/);
  assert.notEqual(row.label, '🟢 机会');
});

test('Poké Jam is IP risk on the extended list, including a spaced Poké prefix', () => {
  assert.equal(ipRisk('Poké Jam', 'arcade basketball').risk, true);
  assert.equal(ipRisk('minecraft browser', '').risk, true);
  assert.equal(BIG_IP.test('paperclip'), false);
  const row = scoreEarly({ name: 'Poké Jam', weeklyRank: 1, embed: parseEmbedPolicy({}), social: { measured: true } }, NOW);
  assert.equal(row.verdict, 'skip-ip');
  assert.notEqual(row.verdict, 'go');
});

test('directory parsers keep weekly rank and do not drop older listings', () => {
  const home = parseAllTheDlesHome(`
    <ol class="picks">
      <li class="pick" data-slug="gazillion"><span class="pick-name">Gazillion</span><span class="pick-sum">year range</span>
        <a class="key key-go pick-play" href="https://gazillion.example/">Play</a></li>
      <li class="pick" data-slug="plain"><span class="chip chip-alt pick-new">New</span><span class="pick-name">Plain</span>
        <a class="key key-go pick-play" href="https://plain.example/">Play</a></li>
    </ol>
    <section><h2>Newly added</h2>
      <article class="game-card" data-slug="oss-game" data-cats="trivia"><h3>Oss Game</h3><span class="game-sum">static</span>
        <a class="key key-go card-play" href="https://oss.example/">Play</a></article>
    </section>`);
  assert.equal(home.picks[0].weeklyRank, 1);
  assert.equal(home.picks[0].playUrl, 'https://gazillion.example/');
  assert.equal(home.picks[1].isNew, true);
  assert.equal(home.newly[0].name, 'Oss Game');

  const fresh = parseAllTheDlesNew(`
    <h2 class="day-head">Added Oct 20, 2026</h2>
    <article class="game-card" data-slug="oss-game"><h3>Oss Game</h3><span class="chip">launched Oct 20, 2026</span>
      <a class="key key-go card-play" href="https://oss.example/">Play</a></article>
    <h2 class="day-head">Added Sep 1, 2026</h2>
    <article class="game-card" data-slug="old-game"><h3>Old Game</h3><span class="chip">launched Sep 1, 2026</span>
      <a class="key key-go card-play" href="https://old.example/">Play</a></article>`);
  assert.equal(fresh[0].launchedAt, '2026-10-20');
  const merged = mergeDirectoryCandidates({ picks: home.picks, newly: home.newly, fresh });
  assert.equal(merged.find((row) => row.name === 'Old Game').launchedAt, '2026-09-01');
  assert.equal(merged.find((row) => row.name === 'Oss Game').launchedAt, '2026-10-20');
});

test('age is a novelty bonus; a months-old weekly climber with an open niche stays', () => {
  const row = scoreEarly({
    name: 'Still Climbing',
    weeklyRank: 2,
    launchedAt: '2026-07-01',
    lists: ['weekly-hot'],
    blurb: 'pin a country on the daily map',
    embed: parseEmbedPolicy({}),
    social: { measured: true, redditPosts7d: 0, mediaMentions: 0 },
    competition: scoreCompetition({ lane: 'geo', peers: [], playUrl: 'https://climber.example/', answerNests: 0 }),
  }, NOW);
  assert.ok(row.novelty.days > 90);
  assert.ok(row.novelty.score <= 4.5);
  assert.equal(row.verdict, 'early');
  assert.notEqual(row.verdict, 'go');
});

test('a filled answer niche loses on competition, not on a day count', () => {
  const open = scoreCompetition({ lane: 'estimate', peers: [], playUrl: 'https://sizeitup.example/', answerNests: 0 });
  const full = scoreCompetition({ lane: 'estimate', peers: [], playUrl: 'https://sizeitup.example/', answerNests: 5 });
  assert.ok(full.c >= open.c + 3);
  assert.match(full.notes.join(' '), /答案站已挤满/);
  const row = scoreEarly({
    name: 'Size It Up',
    launchedAt: '2026-05-01',
    lists: ['new-60d'],
    blurb: 'estimate the closest scale',
    embed: parseEmbedPolicy({ xFrameOptions: 'DENY', contentSecurityPolicy: "frame-ancestors 'none'" }),
    social: { measured: true, answerNests: 5 },
    competition: full,
  }, NOW);
  assert.ok(row.dims.C >= 7);
  assert.notEqual(row.verdict, 'early');
  assert.notEqual(row.verdict, 'go');
});

test('probe slots prefer an older empty lane over a newer crowded one', () => {
  const counts = new Map([['rarity', 6], ['geo', 1]]);
  const older = { name: 'Climber', blurb: 'pin a country on the daily map', lists: ['new-60d'], launchedAt: '2026-08-01' };
  const younger = { name: 'Rarity Baby', blurb: 'name the rarer answer fewer people pick', lists: ['newly-added'], launchedAt: '2026-10-28' };
  assert.ok(probePriority(older, counts, NOW) > probePriority(younger, counts, NOW));
  const weekly = [1, 2, 3].map((rank) => ({ name: `Week ${rank}`, weeklyRank: rank, blurb: 'year range history', lists: ['weekly-hot'], launchedAt: '2026-06-01' }));
  const picked = selectProbeCandidates([...weekly, older], { limit: 3, now: NOW });
  assert.ok(picked.some((row) => row.name === 'Climber'));
  assert.equal(picked.filter((row) => row.weeklyRank).length, 2);
});

test('repo extraction prefers the named repo and ignores weak search hits', () => {
  const html = '<a href="https://github.com/features/copilot">x</a> <a href="https://github.com/simonw/tools">tools</a> <a href="https://github.com/acme/gazillion">g</a>';
  assert.deepEqual(extractRepoUrls(html), ['https://github.com/simonw/tools', 'https://github.com/acme/gazillion']);
  assert.equal(chooseLinkedRepo(extractRepoUrls(html), { name: 'Gazillion', slug: 'gazillion' }), 'https://github.com/acme/gazillion');
  assert.equal(pickSearchRepo({ items: [{ name: 'weather-app', description: 'forecast' }] }, 'Gazillion'), null);
  assert.equal(pickSearchRepo({ items: [{ name: 'plain', description: 'a journal theme' }] }, 'Plain'), null);
  assert.equal(pickSearchRepo({ items: [{ name: 'GazillionaireClone', description: 'remake of the DOS game', created_at: '2026-10-01T00:00:00Z', html_url: 'https://github.com/rnandon/GazillionaireClone' }] }, 'Gazillion', { now: NOW }), null);
  assert.equal(pickSearchRepo({ items: [{ name: 'moonshot', description: 'Moonshot GitHubGameOff 2020 contribution', created_at: '2020-11-28T00:00:00Z', homepage: 'https://lallassu.itch.io/moonshot', topics: ['game'] }] }, 'Moonshot', { playHost: 'moonshotdailygame.com', now: NOW }), null);
  assert.equal(pickSearchRepo({ items: [{ name: 'gazillion', description: 'daily browser game', created_at: '2026-10-20T00:00:00Z', html_url: 'https://github.com/acme/gazillion' }] }, 'Gazillion', { now: NOW }).html_url, 'https://github.com/acme/gazillion');
});

test('dedicated play host is the Trends query so a common word is not the series', () => {
  assert.equal(trendsQueryFor({ name: 'Plain', playUrl: 'https://playplain.app/' }), 'playplain.app');
  assert.equal(trendsQueryFor({ name: 'Oss Daily', playUrl: 'https://dev.itch.io/oss-game' }), 'Oss Daily');
});

test('short Trends window ignores the partial point', () => {
  const timeline = [
    ...Array.from({ length: 7 }, () => ({ value: [90, 1], isPartial: false })),
    { value: [90, 100], isPartial: true },
  ];
  assert.deepEqual(meansFromTimeline(timeline, 1), { trends7: 1, trends30: 1 });
});

test('itch and newgrounds parsers reuse the existing listing readers', () => {
  const itch = parseItchNewest('<a class="title" href="https://dev.itch.io/oss-game">Oss Daily</a><a class="title" href="https://dev.itch.io/x">untitled jam</a>');
  assert.equal(itch.length, 1);
  assert.equal(itch[0].name, 'Oss Daily');
  assert.deepEqual(itch[0].lists, ['itch-newest-web']);
  const ng = parseNewgroundsTop(`<rss><channel><item><title>5. Tree Game by Author</title><link>https://www.newgrounds.com/portal/view/1</link><pubDate>Wed, 28 Oct 2026 00:00:00 GMT</pubDate></item></channel></rss>`);
  assert.equal(ng[0].name, 'Tree Game');
  assert.equal(ng[0].lists[0], 'newgrounds-daily-top');
});

test('runEarlyPlayableWatch fills embed, content, and open-source columns without portal Suggest', async () => {
  const home = `<ol class="picks"><li class="pick" data-slug="gazillion"><span class="pick-name">Gazillion</span><span class="pick-sum">year range</span><a class="key key-go pick-play" href="https://gazillion.example/">Play</a></li><li class="pick" data-slug="plain"><span class="pick-name">Plain</span><span class="pick-sum">closest number</span><a class="key key-go pick-play" href="https://plain.example/">Play</a></li></ol><section><h2>Newly added</h2><article class="game-card" data-slug="oss-game"><h3>Oss Game</h3><span class="game-sum">static html</span><a class="key key-go card-play" href="https://oss.example/">Play</a></article></section>`;
  const newer = `<h2 class="day-head">Added Oct 20, 2026</h2><article class="game-card" data-slug="oss-game"><h3>Oss Game</h3><span class="chip">launched Oct 20, 2026</span><a class="key key-go card-play" href="https://oss.example/">Play</a></article>`;
  const seen = [];
  const fetchImpl = async (url) => {
    const u = String(url);
    seen.push(u);
    const body = (status, headers, text) => ({
      ok: status >= 200 && status < 300,
      status,
      url: u,
      headers: new Headers(headers),
      text: async () => text,
      json: async () => JSON.parse(text),
    });
    if (u.startsWith('https://allthedles.com/new')) return body(200, {}, newer);
    if (u.startsWith('https://allthedles.com')) return body(200, {}, home);
    if (u.startsWith('https://gazillion.example')) return body(200, {}, '<html><body>daily</body></html>');
    if (u.startsWith('https://plain.example')) return body(200, { 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" }, '<html></html>');
    if (u.startsWith('https://oss.example')) return body(200, {}, '<html><body><a href="https://github.com/acme/oss-game">source</a><script src="three.js"></script><canvas></canvas></body></html>');
    if (u === 'https://api.github.com/repos/acme/oss-game') return body(200, {}, JSON.stringify({ license: { spdx_id: 'Apache-2.0' }, language: 'HTML', description: 'browser game', topics: ['html5'] }));
    if (u.startsWith('https://api.github.com/repos/acme/oss-game/contents')) return body(200, {}, JSON.stringify([{ name: 'index.html' }]));
    if (u.includes('api.github.com/search')) return body(200, {}, JSON.stringify({ items: [] }));
    if (u.includes('reddit.com')) return body(403, {}, '{}');
    if (u.includes('duckduckgo.com')) return body(200, {}, '<html><body></body></html>');
    throw new Error(`unexpected ${u}`);
  };
  const timeline = [
    ...Array.from({ length: 29 }, () => ({ value: [80, 1, 1, 1], isPartial: false })),
    { value: [80, 100, 100, 100], isPartial: true },
  ];
  const result = await runEarlyPlayableWatch({
    now: new Date(NOW),
    limit: 5,
    includeIndies: false,
    fetchImpl,
    pause: async () => {},
    stateFile: path.join(os.tmpdir(), `playable-early-${process.pid}.json`),
    trendsImpl: async () => JSON.stringify({ default: { timelineData: timeline } }),
  });
  assert.equal(seen.some((url) => url.includes('suggestqueries')), false);
  const byName = Object.fromEntries(result.rows.map((row) => [row.name, row]));
  assert.equal(byName.Gazillion.paths.embed.open, true);
  assert.equal(byName.Gazillion.paths.content.role, 'fallback');
  assert.equal(byName.Gazillion.paths.oss.found, false);
  assert.equal(byName.Gazillion.trends7, 1);
  assert.equal(byName.Plain.paths.embed.open, false);
  assert.equal(byName.Plain.paths.content.role, 'primary');
  assert.equal(byName['Oss Game'].paths.oss.deployable, true);
  assert.match(byName['Oss Game'].paths.oss.repoUrl, /acme\/oss-game/);
  for (const row of result.rows) {
    assert.notEqual(row.verdict, 'go');
    assert.equal(row.tag, 'early / social');
  }
  const markdown = renderEarlySection(result);
  assert.match(markdown, /嵌入路径/);
  assert.match(markdown, /内容路径/);
  assert.match(markdown, /开源部署/);
  assert.match(markdown, /优先 \[acme\/oss-game\]/);
  assert.match(markdown, /主路径·答案\/归档/);
  assert.match(markdown, /early \/ social/);
});
