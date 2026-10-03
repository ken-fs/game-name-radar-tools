import dns from 'node:dns/promises';
import net from 'node:net';

const USER_AGENT = 'GameNameRadar/1.0 (+https://github.com/)';
const MAX_BYTES = 2_500_000;
const FETCH_TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 3;

/**
 * 198.18.0.0/15 是 RFC 2544 的基准测试段，**同时也是本机 Clash 的 fake-ip 段**。
 *
 * 这条排除项是 2026-10-03 加的，因为那天 20 个信息源挂了 14 个：Clash 在 TUN 模式下
 * 把 itch.io / Steam / Newgrounds 等全部解析成 198.18.x.x，守卫按保留段拒绝，
 * 于是「域名无法访问」被误报成「地址不安全」。
 *
 * 为什么不干脆去掉这个段：它确实是保留段。但在这台机器上 198.18/15 只会是
 * Clash 生成的假 IP —— 不可路由，也就没有 SSRF 可达性。真正的内网段（10/172.16/
 * 192.168/LAN）一条都没放松，指向它们仍然被拦。
 */
function isPrivateIpv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return false;
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function isPrivateIpv6(ip) {
  const value = ip.toLowerCase();
  return (
    value === '::' ||
    value === '::1' ||
    value.startsWith('fc') ||
    value.startsWith('fd') ||
    value.startsWith('fe8') ||
    value.startsWith('fe9') ||
    value.startsWith('fea') ||
    value.startsWith('feb') ||
    value.startsWith('::ffff:127.') ||
    value.startsWith('::ffff:10.') ||
    value.startsWith('::ffff:192.168.')
  );
}

async function assertPublicUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error('URL 格式不正确');
  }

  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只允许 HTTP 或 HTTPS URL');
  if (url.username || url.password) throw new Error('URL 不允许包含账号密码');
  if (['localhost', 'localhost.localdomain'].includes(url.hostname.toLowerCase())) throw new Error('不允许访问本地地址');

  const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length) throw new Error('域名无法解析');
  for (const { address } of addresses) {
    const family = net.isIP(address);
    if ((family === 4 && isPrivateIpv4(address)) || (family === 6 && isPrivateIpv6(address))) {
      throw new Error('不允许访问内网或保留地址');
    }
  }
  return url;
}

async function readLimitedText(response) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) throw new Error('响应内容过大');
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new Error('响应内容超过 2.5MB 限制');
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(merged);
}

export async function safeFetchText(input, redirectCount = 0) {
  const url = await assertPublicUrl(input);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': USER_AGENT,
        accept: 'application/xml,text/xml,application/rss+xml,application/atom+xml,text/html;q=0.9,*/*;q=0.5',
      },
      redirect: 'manual',
      signal: controller.signal,
    });

    if (response.status >= 300 && response.status < 400) {
      if (redirectCount >= MAX_REDIRECTS) throw new Error('重定向次数过多');
      const location = response.headers.get('location');
      if (!location) throw new Error('重定向缺少 Location');
      return safeFetchText(new URL(location, url).toString(), redirectCount + 1);
    }

    if (!response.ok) throw new Error(`远程站点返回 ${response.status}`);
    return {
      text: await readLimitedText(response),
      finalUrl: url.toString(),
      contentType: response.headers.get('content-type') || '',
    };
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('请求超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(value = '') {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .trim();
}

function stripHtml(value = '') {
  return decodeEntities(value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
}

function extractTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? decodeEntities(match[1]) : '';
}

function normalizeUrl(value, baseUrl) {
  if (!value) return '';
  try {
    return new URL(decodeEntities(value), baseUrl).toString();
  } catch {
    return '';
  }
}

function parseSitemapXml(text, baseUrl) {
  const sitemapBlocks = [...text.matchAll(/<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi)];
  if (sitemapBlocks.length) {
    return {
      type: 'sitemap-index',
      children: sitemapBlocks.map((match) => normalizeUrl(extractTag(match[1], 'loc'), baseUrl)).filter(Boolean),
      entries: [],
    };
  }

  const urlBlocks = [...text.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)];
  if (!urlBlocks.length) return null;
  return {
    type: 'sitemap',
    children: [],
    entries: urlBlocks.map((match) => ({
      url: normalizeUrl(extractTag(match[1], 'loc'), baseUrl),
      title: '',
      date: extractTag(match[1], 'lastmod'),
    })).filter((entry) => entry.url),
  };
}

function parseFeedXml(text, baseUrl) {
  const itemBlocks = [...text.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];
  if (itemBlocks.length) {
    return {
      type: 'feed',
      entries: itemBlocks.map((match) => {
        const block = match[1];
        return {
          title: stripHtml(extractTag(block, 'title')),
          url: normalizeUrl(extractTag(block, 'link') || extractTag(block, 'guid'), baseUrl),
          date: extractTag(block, 'pubDate') || extractTag(block, 'dc:date'),
        };
      }).filter((entry) => entry.url),
      children: [],
    };
  }

  const entryBlocks = [...text.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)];
  if (!entryBlocks.length) return null;
  return {
    type: 'feed',
    entries: entryBlocks.map((match) => {
      const block = match[1];
      const hrefMatch = block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i);
      return {
        title: stripHtml(extractTag(block, 'title')),
        url: normalizeUrl(hrefMatch?.[1] || extractTag(block, 'link'), baseUrl),
        date: extractTag(block, 'updated') || extractTag(block, 'published'),
      };
    }).filter((entry) => entry.url),
    children: [],
  };
}

function cleanListingTitle(value = '') {
  return stripHtml(value)
    .replace(/^(?:new|hot|top|updated|originals?)\s+/i, '')
    .replace(/\s+(?:new|hot|top|updated|originals?)$/i, '')
    .replace(/\s+\d(?:\.\d)?$/i, '')
    .replace(/\s+(?:game\s+)?new$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function anchorAttribute(attrs, name) {
  return attrs.match(new RegExp(`${name}=["']([^"']+)["']`, 'i'))?.[1] || '';
}

function parseAnchors(text, baseUrl) {
  const results = [];
  const regex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of text.matchAll(regex)) {
    const attrs = match[1];
    const url = normalizeUrl(anchorAttribute(attrs, 'href'), baseUrl);
    if (!url) continue;
    const imageAlt = match[2].match(/<img\b[^>]*alt=["']([^"']+)["'][^>]*>/i)?.[1] || '';
    const rawTitle = anchorAttribute(attrs, 'aria-label') || anchorAttribute(attrs, 'title') || stripHtml(match[2]) || imageAlt;
    results.push({ url, title: cleanListingTitle(rawTitle), date: '' });
  }
  return results;
}

const LISTING_PROFILES = {
  'poki-listing': { path: /^\/(?:[a-z]{2}\/)?g\/[a-z0-9-]+\/?$/i },
  'crazygames-listing': { path: /^\/(?:[a-z]{2}\/)?game\/[a-z0-9-]+\/?$/i },
  'y8-listing': { path: /^\/games\/[a-z0-9_%-]+\/?$/i },
  'gamepix-listing': { path: /^\/play\/[a-z0-9-]+\/?$/i },
  'lagged-listing': { path: /^\/(?:[a-z]{2}\/)?g\/[a-z0-9-]+\/?$/i },
};

function parsePortalHtml(text, baseUrl, kind) {
  const profile = LISTING_PROFILES[kind];
  const base = new URL(baseUrl);
  const seen = new Set();
  const entries = [];
  for (const entry of parseAnchors(text, baseUrl)) {
    let url;
    try { url = new URL(entry.url); } catch { continue; }
    if (url.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) continue;
    if (!profile?.path.test(url.pathname)) continue;
    if (!entry.title || entry.title.length < 2 || seen.has(url.toString())) continue;
    seen.add(url.toString());
    entries.push({ ...entry, url: url.toString() });
  }
  return { type: kind, entries, children: [] };
}

function parseItchHtml(text, baseUrl) {
  const entries = [];
  const seen = new Set();
  const anchorRegex = /<a\b([^>]*class=["'][^"']*\btitle\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of text.matchAll(anchorRegex)) {
    const href = match[1].match(/href=["']([^"']+)["']/i)?.[1];
    const url = normalizeUrl(href, baseUrl);
    const title = cleanListingTitle(match[2]);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    entries.push({ url, title, date: '' });
  }
  return { type: 'itch-listing', entries, children: [] };
}

export function parseRemoteDocument(text, baseUrl, requestedKind = 'auto') {
  const trimmed = text.trim();
  if (requestedKind === 'itch-listing') return parseItchHtml(text, baseUrl);
  if (LISTING_PROFILES[requestedKind]) return parsePortalHtml(text, baseUrl, requestedKind);
  if (requestedKind === 'sitemap') return parseSitemapXml(text, baseUrl) || { type: 'sitemap', entries: [], children: [] };
  if (requestedKind === 'feed') return parseFeedXml(text, baseUrl) || { type: 'feed', entries: [], children: [] };
  if (/^<\?xml|<urlset\b|<sitemapindex\b|<rss\b|<feed\b/i.test(trimmed)) {
    return parseSitemapXml(text, baseUrl) || parseFeedXml(text, baseUrl) || { type: 'xml', entries: [], children: [] };
  }
  if (/itch\.io/i.test(baseUrl) || /game_cell|class=["'][^"']*title/i.test(text)) return parseItchHtml(text, baseUrl);
  return { type: 'unknown', entries: [], children: [] };
}

function wordsFromSlug(slug) {
  const stopWords = new Set(['play', 'online', 'game', 'games', 'free', 'unblocked', 'html5', 'browser', 'download', 'new', 'official', 'web', 'guide', 'walkthrough', 'wiki', 'codes']);
  return slug
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[_+]+/g, '-')
    .split('-')
    .map((word) => word.trim())
    .filter(Boolean)
    .filter((word) => !stopWords.has(word.toLowerCase()));
}

export function deriveGameName(entry) {
  if (entry.title) {
    const cleaned = stripHtml(entry.title)
      .replace(/\s*[|–—-]\s*(play online|itch\.io|free online game|game)$/i, '')
      .replace(/^play\s+/i, '')
      .replace(/\s+(online|unblocked|game)$/i, '')
      .trim();
    if (cleaned.length >= 2) return cleaned;
  }

  try {
    const url = new URL(entry.url);
    const segments = url.pathname.split('/').filter(Boolean);
    const slug = segments.at(-1) || url.hostname.split('.')[0];
    return wordsFromSlug(decodeURIComponent(slug))
      .map((word) => word.length <= 3 && word === word.toUpperCase() ? word : word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')
      .trim();
  } catch {
    return '';
  }
}

export function normalizeGameName(value = '') {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(play|online|game|games|free|unblocked|html5|browser)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueEntries(entries, limit) {
  const map = new Map();
  for (const entry of entries) {
    if (!entry.url || map.has(entry.url)) continue;
    map.set(entry.url, {
      url: entry.url,
      title: entry.title || '',
      date: entry.date || '',
      gameName: deriveGameName(entry),
    });
    if (map.size >= limit) break;
  }
  return [...map.values()];
}

export async function scanSource(source, options = {}) {
  const maxEntries = Math.min(Math.max(options.maxEntries || 800, 1), 2000);
  const maxChildren = Math.min(Math.max(options.maxChildren || 16, 0), 40);
  const depth = options.depth || 0;
  const fetched = await safeFetchText(source.url);
  const parsed = parseRemoteDocument(fetched.text, fetched.finalUrl, source.kind || 'auto');

  if (parsed.type === 'sitemap-index' && depth < 2 && maxChildren > 0) {
    const childUrls = parsed.children.slice(0, maxChildren);
    const childResults = [];
    for (let index = 0; index < childUrls.length; index += 4) {
      const chunk = childUrls.slice(index, index + 4);
      const settled = await Promise.allSettled(chunk.map((url) => scanSource(
        { ...source, url, kind: 'sitemap' },
        { maxEntries, maxChildren: 0, depth: depth + 1 },
      )));
      for (const item of settled) if (item.status === 'fulfilled') childResults.push(...item.value.entries);
      if (childResults.length >= maxEntries) break;
    }
    return {
      sourceId: source.id,
      sourceName: source.name,
      sourceUrl: source.url,
      detectedType: parsed.type,
      entries: uniqueEntries(childResults, maxEntries),
      childSitemaps: childUrls.length,
      scannedAt: new Date().toISOString(),
    };
  }

  return {
    sourceId: source.id,
    sourceName: source.name,
    sourceUrl: source.url,
    detectedType: parsed.type,
    entries: uniqueEntries(parsed.entries, maxEntries),
    childSitemaps: 0,
    scannedAt: new Date().toISOString(),
  };
}

export function calculateCandidateScore(candidate) {
  const sources = candidate.sources || [];
  const kinds = new Set(sources.map((source) => source.kind));
  let score = 0;
  for (const kind of kinds) {
    if (kind === 'itch-featured') score += 5;
    else if (kind === 'itch-popular') score += 4;
    else if (['crazygames-new', 'poki-new', 'y8-new', 'gamepix-new', 'lagged-new', 'competitor-sitemap'].includes(kind)) score += 3;
    else if (kind === 'itch-new' || kind === 'feed') score += 2;
    else score += 1;
  }
  if (sources.length >= 3) score += 7;
  else if (sources.length === 2) score += 4;

  const wordCount = candidate.gameName.trim().split(/\s+/).filter(Boolean).length;
  if (candidate.gameName.length >= 5 && candidate.gameName.length <= 45 && wordCount >= 1 && wordCount <= 6) score += 2;
  if (/^(game|online game|new game|untitled)$/i.test(candidate.gameName)) score -= 5;
  const dates = sources.map((source) => Date.parse(source.date || '')).filter(Number.isFinite);
  if (dates.length && Date.now() - Math.max(...dates) < 3 * 86400000) score += 2;
  return Math.max(0, Math.min(20, score));
}

export function candidateLevel(score) {
  if (score >= 12) return 'hot';
  if (score >= 7) return 'verify';
  return 'watch';
}
