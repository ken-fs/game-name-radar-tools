import { safeFetchText } from './scanner.mjs';

function decode(value='') {
  return value
    .replace(/&amp;/g,'&')
    .replace(/&quot;/g,'"')
    .replace(/&#39;|&apos;/g,"'")
    .replace(/&lt;/g,'<')
    .replace(/&gt;/g,'>')
    .replace(/<[^>]+>/g,' ')
    .replace(/\s+/g,' ')
    .trim();
}

export function parseSteamSearch(html='') {
  const entries=[];
  const seen=new Set();
  const regex=/<a\b([^>]*class=["'][^"']*search_result_row[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi;
  for(const match of html.matchAll(regex)){
    const attrs=match[1];
    const body=match[2];
    const href=attrs.match(/href=["']([^"']+)["']/i)?.[1];
    const title=decode(body.match(/<span\b[^>]*class=["']title["'][^>]*>([\s\S]*?)<\/span>/i)?.[1]||'');
    const releaseDate=decode(body.match(/<div\b[^>]*class=["'][^"']*search_released[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1]||'');
    if(!href||!title)continue;
    let url;
    try{url=new URL(href,'https://store.steampowered.com').toString()}catch{continue}
    if(!/store\.steampowered\.com\/app\/\d+/i.test(url)||seen.has(url))continue;
    seen.add(url);
    entries.push({url,title,date:releaseDate,releaseDate,gameName:title});
  }
  return entries;
}

// 第 2 页起走 /search/results/ 的 JSON 接口（start 偏移，每页 50 条）
export function steamResultsPageUrl(sourceUrl, start){
  const url=new URL(sourceUrl);
  url.pathname='/search/results/';
  url.searchParams.set('start',String(start));
  url.searchParams.set('count','50');
  url.searchParams.set('infinite','1');
  return url.toString();
}

export async function scanSteamSource(source, options={}){
  const pages=Math.min(Math.max(source.pages||1,1),6);
  const maxEntries=Math.min(Math.max(options.maxEntries||pages*50,1),300);
  const fetched=await safeFetchText(source.url);
  let html=fetched.text;
  // 后续页失败不影响第一页结果（Steam 偶发返回空响应）
  for(let page=1;page<pages;page++){
    try{
      const more=await safeFetchText(steamResultsPageUrl(source.url,page*50));
      html+=JSON.parse(more.text).results_html||'';
    }catch{break}
  }
  return {
    sourceId:source.id,
    sourceName:source.name,
    sourceUrl:source.url,
    detectedType:'steam-listing',
    entries:parseSteamSearch(html).slice(0,maxEntries),
    childSitemaps:0,
    scannedAt:new Date().toISOString(),
  };
}
