#!/bin/bash
# 每日雷达（launchd com.ken.game-radar 调用；北京时间 12:30–22:30 每小时一个时间点，
# 按**美东时间**判断：美东当天 00:30 之后才跑（美区前一天的搜索 / 上新数据已完整），
# 跑成功一次后当天其余时间点直接跳过。夏令时由 TZ=America/New_York 自动处理：
# 夏令时期间北京 12:30 开跑，11 月起冬令时 13:30 开跑。）
#
# 为什么要这层壳（2026-10-08 排查）：
# - 10-04：08:30 没开机，整天没跑
# - 10-06、10-07：08:30 刚唤醒、网络和代理还没起来，20 个信息源全部 ENOTFOUND，等于白跑
# - 10-08：Google 探测一次超时，投入价值 / 梗 / 可玩三个子雷达被静默跳过
# - 日志在 /tmp，重启就没了，查不到原因
#
# 现在：先等网络就绪（最多 15 分钟）→ 跑 scan.mjs → 检查这次是不是「真成功」→ 成功才写当天的完成标记、
# 再跑 radar.mjs 出总报告；不成功就不写标记，下一个时间点自动重试；当天最后一次还失败就弹通知。
set -u
HERE="$HOME/Desktop/david/Ship/game-name-radar"
SHIP="$HOME/Desktop/david/Ship"
NODE="$HOME/.nvm/versions/node/v22.22.0/bin/node"
LOGDIR="$SHIP/out/logs"
TODAY=$(date +%F)                          # 报告文件名用的本地日期（美东 00:30 之后与美东日期一致）
US_DAY=$(TZ=America/New_York date +%F)
US_HM=$(TZ=America/New_York date +%H%M)
DONE="$LOGDIR/game-radar-ok-$US_DAY"
LAST_SLOT_HOUR=22
mkdir -p "$LOGDIR"
exec >>"$LOGDIR/game-radar.log" 2>&1
cd "$HERE" || exit 1
echo "=== $(date '+%F %T') 开始"

if [ "${1:-}" != "--force" ]; then
  if [ "$US_HM" -lt 0030 ] || [ "$US_HM" -ge 1200 ]; then
    # 只在美东 00:30–12:00 之间跑（对应北京下午到晚上）；不在窗口里的时间点直接跳过
    echo "美东 $US_HM 不在 00:30–12:00 窗口，跳过"
    exit 0
  fi
  if [ -f "$DONE" ]; then
    echo "美东 $US_DAY 已经成功跑过，跳过"
    exit 0
  fi
fi

# 1. 等网络：能通过代理或直连拿到 Google 204 才算就绪
net_ok=""
for i in $(seq 1 30); do
  if curl -s -x http://127.0.0.1:7897 --max-time 8 -o /dev/null -w '%{http_code}' https://www.google.com/generate_204 | grep -q 204; then
    export NODE_USE_ENV_PROXY=1 https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897
    net_ok="proxy"; break
  fi
  if curl -s --max-time 8 -o /dev/null -w '%{http_code}' https://www.google.com/generate_204 | grep -q 204; then
    unset NODE_USE_ENV_PROXY https_proxy http_proxy
    net_ok="direct"; break
  fi
  sleep 30
done
if [ -z "$net_ok" ]; then
  echo "等了 15 分钟网络还没就绪，这一轮不跑，下个时间点再试"
  exit 1
fi
echo "网络就绪（$net_ok）"

# 2. 主管线（Steam / itch / HTML5 / Trends / 投入价值 / 梗 / 可玩）
"$NODE" --env-file-if-exists=.env scripts/scan.mjs 2>&1 | grep --line-buffered -v -e EnvHttpProxyAgent -e trace-warnings

# 3. 判断是不是真成功：信息源至少七成成功，而且梗 / 可玩两份当天报告都生成了（它们依赖 Google 可达）
verdict=$("$NODE" -e '
const fs=require("fs");const today=process.argv[1];
const r=JSON.parse(fs.readFileSync("data/latest-report.json","utf8"));
const fresh=(Date.now()-Date.parse(r.scannedAt))<3*3600e3;
const src=r.sources||[];const ok=src.filter(s=>s.ok).length;
const meme=fs.existsSync(`../RADAR-MEME-${today}.md`),playable=fs.existsSync(`../RADAR-PLAYABLE-${today}.md`);
const pass=fresh&&src.length>0&&ok/src.length>=0.7&&meme&&playable;
console.log(`${pass?"OK":"FAIL"} 信息源 ${ok}/${src.length} · 梗报告 ${meme?"有":"无"} · 可玩报告 ${playable?"有":"无"} · 本次扫描 ${fresh?"新":"旧"}`);
' "$TODAY")
echo "$verdict"

if [[ "$verdict" != OK* ]]; then
  if [ "$(date +%H)" -ge "$LAST_SLOT_HOUR" ]; then
    osascript -e "display notification \"$verdict。日志：Ship/out/logs/game-radar.log\" with title \"游戏雷达今天没跑成\"" 2>/dev/null
  fi
  exit 1
fi

# 4. 总报告（Roblox 现跑 + 汇总上面的报告）
"$NODE" radar.mjs 2>&1 | grep --line-buffered -v -e EnvHttpProxyAgent -e trace-warnings
touch "$DONE"
find "$LOGDIR" -name 'game-radar-ok-*' -mtime +14 -delete
echo "=== $(date '+%F %T') 完成"
