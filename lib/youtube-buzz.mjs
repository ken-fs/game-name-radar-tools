#!/usr/bin/env node
/**
 * youtube-buzz.mjs — YouTube 传播信号检测（零 API key，基于 yt-dlp）
 *
 * 用途：验证游戏热度是否在「快速传播中」——多个独立创作者近期发布 = 传播信号。
 * 这是 roblox-growth-scan 的补充佐证层（游戏数据强 + YouTube 传播强 = 双重确认）。
 *
 * 用法：
 *   node lib/youtube-buzz.mjs "Command An Army" "另一个游戏名"
 *   （需要代理：NODE_USE_ENV_PROXY=1 https_proxy=http://127.0.0.1:7897）
 *
 * 信号定义（每个游戏跑 3 个查询）：
 *   1. 总览（ytsearch15）      → 独立频道数 + 播放量规模
 *   2. 本周筛选（sp=EgQIAxAB）  → 本周视频数 + 本周独立频道数 ← 核心信号
 *   3. 今日筛选（sp=EgQIAhAB）  → 今日视频数（爆发检测）
 *
 * 判读基准（校准自 Command An Army 实测：本周 20 视频 / 17 频道）：
 *   本周独立频道 ≥10 = 🔥 强传播 ｜ 5-9 = 📈 传播中 ｜ 2-4 = 🌱 起步 ｜ 0-1 = ❄️ 冷
 *   今日视频 ≥3 = 爆发期 ｜ 1-2 = 活跃
 */
import { execFileSync } from 'node:child_process';

const games = process.argv.slice(2);
if (!games.length) {
  console.log('用法: node lib/youtube-buzz.mjs "游戏名" ["游戏名2" ...]');
  process.exit(1);
}

const THIS_WEEK = 'EgQIAxAB'; // YouTube sp 筛选参数：本周
const TODAY = 'EgQIAhAB'; // 今日

function ytSearch(args) {
  try {
    const out = execFileSync('yt-dlp', args, {
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 20 * 1024 * 1024,
    });
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return null; // 失败 = 未测（不编造）
  }
}

function summarize(rows) {
  if (!rows) return null;
  const channels = new Set(rows.map((r) => r.channel).filter(Boolean));
  const views = rows.map((r) => r.view_count ?? 0).filter((v) => v > 0);
  return {
    videos: rows.length,
    channels: channels.size,
    totalViews: views.reduce((a, b) => a + b, 0),
    medianViews: views.length ? views.sort((a, b) => a - b)[Math.floor(views.length / 2)] : 0,
  };
}

console.log('\n═══ YouTube 传播信号 ═══\n');

for (const game of games) {
  const q = encodeURIComponent(`${game} roblox`);
  const overview = summarize(ytSearch(['ytsearch15:' + game + ' roblox', '--flat-playlist', '--dump-json', '--no-warnings']));
  const week = summarize(ytSearch([`https://www.youtube.com/results?search_query=${q}&sp=${THIS_WEEK}`, '--flat-playlist', '--dump-json', '--no-warnings', '--playlist-end', '20']));
  const today = summarize(ytSearch([`https://www.youtube.com/results?search_query=${q}&sp=${TODAY}`, '--flat-playlist', '--dump-json', '--no-warnings', '--playlist-end', '20']));

  console.log(`── ${game}`);
  if (!overview && !week && !today) {
    console.log('   ⚠️ 未测（yt-dlp 全部失败——检查代理）\n');
    continue;
  }
  // 打满抓取上限 = 饱和（真实值 ≥ 上限）
  const sat = (n, cap) => (n >= cap ? `${n}+` : `${n}`);
  if (overview) {
    console.log(`   总览: ${overview.videos} 视频 / ${overview.channels} 独立频道 / 中位播放 ${overview.medianViews.toLocaleString()}`);
  }
  if (week) {
    const verdict = week.channels >= 10 ? '🔥 强传播' : week.channels >= 5 ? '📈 传播中' : week.channels >= 2 ? '🌱 起步' : '❄️ 冷';
    console.log(`   本周: ${sat(week.videos, 20)} 视频 / ${sat(week.channels, 20)} 独立频道  → ${verdict}`);
  } else {
    console.log('   本周: 未测');
  }
  if (today) {
    const burst = today.videos >= 3 ? '🚀 爆发期' : today.videos >= 1 ? '活跃' : '—';
    console.log(`   今日: ${sat(today.videos, 20)} 视频  → ${burst}`);
  } else {
    console.log('   今日: 未测');
  }
  console.log();
}
