/**
 * google-trends.mjs — google-trends-api 的替身（2026-10-08 加）
 *
 * 为什么换：google-trends-api 调接口不带 Google 的 Cookie，2026-10 起几乎每次都被 302 到
 * /sorry（「检测到异常流量」页），Trends 验证 / 可玩游戏 rising / Roblox 需求验证全靠它，
 * 于是天天「Unexpected token '<'」。这里先访问一次 trends.google.com 拿 NID Cookie，
 * 之后带着 Cookie 调同样的接口（和研究时一直能用的 trends.py 同一套做法）。
 *
 * 接口和返回值跟 google-trends-api 一样（返回去掉 `)]}'` 前缀的 JSON 字符串），调用方只改 import：
 *   interestOverTime({ keyword, startTime, endTime, geo, hl, timezone })
 *   interestByRegion({ keyword, startTime, endTime, geo, resolution, hl, timezone })
 *   relatedQueries({ keyword, startTime, endTime, geo, hl, timezone })
 * 出错照样 throw（调用方原来就有 try/catch）。
 */

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const BASE = "https://trends.google.com/trends";

let cookie = "";
let cookieAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function refreshCookie() {
  const res = await fetch(`${BASE}/?geo=US`, { headers: { "Accept-Language": "en-US", "User-Agent": UA }, redirect: "manual", signal: AbortSignal.timeout(20_000) });
  const parts = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie") ?? ""];
  cookie = parts.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
  cookieAt = Date.now();
}

/** GET 一个 Trends 接口，返回 `)]}'` 之后的 JSON 文本。被拦 / 限流时换 Cookie 并退避重试。 */
async function getJsonText(url) {
  let lastError = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!cookie || Date.now() - cookieAt > 30 * 60_000) {
      await refreshCookie().catch((e) => {
        lastError = `cookie: ${e.message}`;
      });
    }
    try {
      const res = await fetch(url, {
        headers: { "Accept-Language": "en-US", Cookie: cookie, "User-Agent": UA },
        redirect: "manual",
        signal: AbortSignal.timeout(25_000),
      });
      const text = await res.text();
      const start = text.indexOf("{");
      if (res.status === 200 && start >= 0 && !text.startsWith("<")) {
        return text.slice(start);
      }
      lastError = `HTTP ${res.status}${res.status === 302 ? " (sorry page)" : ""}`;
      cookie = ""; // 302 / 429：换一个 Cookie 再来
    } catch (error) {
      lastError = error.message;
    }
    await sleep(4000 * (attempt + 1));
  }
  throw new Error(`Google Trends request failed: ${lastError}`);
}

const ymd = (d) => new Date(d).toISOString().slice(0, 10);

function timeRange(startTime, endTime) {
  const end = endTime ? new Date(endTime) : new Date();
  const start = startTime ? new Date(startTime) : new Date("2004-01-01");
  return `${ymd(start)} ${ymd(end)}`;
}

async function explore({ keyword, startTime, endTime, geo = "", hl = "en-US", timezone = 0, category = 0 }) {
  const keywords = Array.isArray(keyword) ? keyword : [keyword];
  const time = timeRange(startTime, endTime);
  const req = {
    category,
    comparisonItem: keywords.map((k) => ({ geo: geo || "", keyword: k, time })),
    property: "",
  };
  const text = await getJsonText(`${BASE}/api/explore?hl=${encodeURIComponent(hl)}&tz=${timezone}&req=${encodeURIComponent(JSON.stringify(req))}`);
  return { hl, timezone, widgets: JSON.parse(text).widgets ?? [] };
}

function widgetUrl(path, hl, timezone, request, token) {
  return `${BASE}/api/widgetdata/${path}?hl=${encodeURIComponent(hl)}&tz=${timezone}&req=${encodeURIComponent(JSON.stringify(request))}&token=${encodeURIComponent(token)}`;
}

export async function interestOverTime(options) {
  const { hl, timezone, widgets } = await explore(options);
  const w = widgets.find((x) => x.id === "TIMESERIES");
  if (!w) throw new Error("Google Trends: no TIMESERIES widget");
  return getJsonText(widgetUrl("multiline", hl, timezone, w.request, w.token));
}

export async function interestByRegion(options) {
  const { hl, timezone, widgets } = await explore(options);
  const w = widgets.find((x) => x.id === "GEO_MAP" || x.id === "GEO_MAP_0");
  if (!w) throw new Error("Google Trends: no GEO_MAP widget");
  const request = { ...w.request, resolution: options.resolution || w.request.resolution || "COUNTRY" };
  return getJsonText(widgetUrl("comparedgeo", hl, timezone, request, w.token));
}

export async function relatedQueries(options) {
  const { hl, timezone, widgets } = await explore(options);
  const w = widgets.find((x) => x.id === "RELATED_QUERIES" || x.id === "RELATED_QUERIES_0");
  if (!w) throw new Error("Google Trends: no RELATED_QUERIES widget");
  return getJsonText(widgetUrl("relatedsearches", hl, timezone, w.request, w.token));
}

export default { interestByRegion, interestOverTime, relatedQueries };
