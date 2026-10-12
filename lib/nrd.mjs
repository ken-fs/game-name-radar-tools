#!/usr/bin/env node
/**
 * nrd.mjs — 新注册域名（NRD）抢注计数（2026-10-12 加）
 *
 * 为什么需要：一个游戏词刚冒头时，同行会先去抢 <游戏名>.wiki / <游戏名>codes.com 之类的域名。
 * 最近几天新注册的域名里含这个名字的越多 = 热度被同行确认了，但窗口也在关（BOMBANANA 复盘：
 * 我们发现后躺了 10 天，同行 9 个 wiki 域名围上来）。
 *
 * 数据：whoisds 免费的每日新注册域名列表（约 7 万个/天，日期是 UTC 注册日）。
 *   - 存放：Ship/out/nrd/<YYYY-MM-DD>.txt.gz（gzip，一行一个域名）
 *   - AI 雷达（ai-term-radar）每天也会下载同一份到同一路径。这里**只在文件不存在时**才自己下，
 *     写临时文件再 rename，不会和对方写到一半的文件冲突。
 *   - 下载地址：https://www.whoisds.com//whois-database/newly-registered-domains/<base64("YYYY-MM-DD.zip")>/nrd
 *     （zip 里一个 domain-names.txt，需代理）
 *
 * 用法：
 *   node lib/nrd.mjs "Volatiles" "EmberQuest"     # 最近 3 天新域名里含这些名字的个数 + 例子
 *   node lib/nrd.mjs --days=5 "aion 2"
 *
 * 其他模块：import { nrdCounts, nrdNote } from './nrd.mjs'
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const NRD_DIR = path.join(root, '..', 'out', 'nrd');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';
const MIN_LEN = 5; // 名字（去空格后）短于 5 个字符不统计：「aion」「fable」会匹到一大堆无关域名
export const NRD_WARN = 3; // ≥3 个 = 同行在抢

/**
 * 名字 → 用来匹配域名的写法：小写、去空格、只留字母数字。
 * 带冒号的（STAR WARS: Galactic Racer）冒号前多是系列名，只加副标题；带破折号的（Probably Stolen - Cyberpunk
 * Shopkeeper Sim）破折号后多是宣传语，只加前半段。
 */
export function nameVariants(name = '') {
  const norm = (s) => String(s).replace(/[™®©]/g, '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '');
  const out = new Set();
  const full = norm(name);
  if (full.length >= MIN_LEN) out.add(full);
  const colon = String(name).split(':');
  if (colon.length > 1) out.add(norm(colon.slice(1).join(':')));
  const dash = String(name).split(/ [-–—|] /);
  if (dash.length > 1) out.add(norm(dash[0]));
  return [...out].filter((v) => v.length >= (v === full ? MIN_LEN : 6));
}

/** 一批域名里含这个名字的：去掉顶级域名后，剩下部分去掉点和横线做子串匹配（play-volatiles.com → playvolatiles）。
 *  不带顶级域名一起拼：volatile.shop 拼起来是 volatileshop，会误中 volatiles。 */
export function matchDomains(domains, name) {
  const variants = nameVariants(name);
  if (!variants.length) return null;
  return domains.filter((d) => {
    const flat = d.toLowerCase().split('.').slice(0, -1).join('').replace(/[^a-z0-9]+/g, '');
    return variants.some((v) => flat.includes(v));
  });
}

const fileFor = (date) => path.join(NRD_DIR, `${date}.txt.gz`);
const utcDate = (offsetDays) => new Date(Date.now() - offsetDays * 864e5).toISOString().slice(0, 10);

/** 没有就下载一份（失败不抛：whoisds 当天的列表要到 UTC 傍晚才有） */
export async function ensureNrdFile(date) {
  const file = fileFor(date);
  if (fs.existsSync(file)) return file;
  const url = `https://www.whoisds.com//whois-database/newly-registered-domains/${Buffer.from(`${date}.zip`).toString('base64')}/nrd`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return null;
    const zip = Buffer.from(await res.arrayBuffer());
    if (zip.subarray(0, 2).toString() !== 'PK') return null; // 还没发布时返回的是 HTML
    fs.mkdirSync(NRD_DIR, { recursive: true });
    const tmpZip = path.join(NRD_DIR, `.${date}.${process.pid}.zip`);
    fs.writeFileSync(tmpZip, zip);
    let text;
    try {
      text = execFileSync('unzip', ['-p', tmpZip], { maxBuffer: 64 * 1024 * 1024 });
    } finally {
      fs.rmSync(tmpZip, { force: true });
    }
    if (fs.existsSync(file)) return file; // 下载期间 AI 雷达已经写好了，用它的
    const tmp = path.join(NRD_DIR, `.${date}.${process.pid}.txt.gz`);
    fs.writeFileSync(tmp, zlib.gzipSync(text));
    fs.renameSync(tmp, file);
    return file;
  } catch {
    return null;
  }
}

/** 最近 days 天（有文件的那几天，从 UTC 今天往前找，最多回看 days+3 天） */
export async function loadRecentNrd(days = 3) {
  const out = [];
  for (let back = 0; back <= days + 3 && out.length < days; back += 1) {
    const date = utcDate(back);
    const file = await ensureNrdFile(date);
    if (!file) continue;
    try {
      const domains = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').split('\n').map((d) => d.trim()).filter(Boolean);
      out.push({ date, domains });
    } catch {
      // 文件坏了（对方写到一半？）就当这天没有
    }
  }
  return out;
}

/**
 * 名字列表 → { name: { count, samples, dates } }；名字太短 / 非拉丁（日韩原文）的给 null。
 * 没有任何 NRD 文件时返回 { available: false }。
 */
export async function nrdCounts(names, { days = 3 } = {}) {
  const lists = await loadRecentNrd(days);
  const result = { available: lists.length > 0, dates: lists.map((l) => l.date), byName: {} };
  for (const name of [...new Set(names.filter(Boolean))]) {
    if (!nameVariants(name).length) {
      result.byName[name] = null;
      continue;
    }
    const hits = lists.flatMap((l) => matchDomains(l.domains, name));
    result.byName[name] = { count: hits.length, samples: hits.slice(0, 5) };
  }
  return result;
}

/** 报告里的一句话：「近 3 天 0 个新域名」/「⚠️ 近 3 天 5 个新域名（同行在抢）：a.wiki, b.com」 */
export function nrdNote(entry, { days = 3, withSamples = true } = {}) {
  if (entry === undefined) return '';
  if (entry === null) return '新域名：名字太短/非英文不统计';
  const { count, samples } = entry;
  if (!count) return `近 ${days} 天 0 个新域名`;
  const head = count >= NRD_WARN ? `⚠️ 近 ${days} 天 ${count} 个新域名（同行在抢）` : `近 ${days} 天 ${count} 个新域名`;
  return withSamples && samples.length ? `${head}：${samples.slice(0, 3).join(', ')}` : head;
}

const IS_MAIN = import.meta.url === `file://${process.argv[1]}` || Boolean(process.argv[1]?.endsWith('nrd.mjs'));
if (IS_MAIN) {
  const args = process.argv.slice(2);
  const days = Number(args.find((a) => a.startsWith('--days='))?.split('=')[1] || 3);
  const names = args.filter((a) => !a.startsWith('--'));
  const r = await nrdCounts(names, { days });
  if (!r.available) {
    console.log('⚠️ 没拿到任何新注册域名列表（whoisds 下载失败，检查代理）');
    process.exit(1);
  }
  console.log(`新注册域名：${r.dates.join(' / ')}（UTC）`);
  for (const n of names) console.log(`  ${n}：${nrdNote(r.byName[n], { days: r.dates.length })}`);
}
