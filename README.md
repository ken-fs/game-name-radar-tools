# Game Name Radar

面向游戏 SEO 趋势站的自动化游戏关键词发现工具。它从游戏平台、Steam、RSS、榜单、Google Trends Rising 和竞争站 Sitemap 中发现候选，再通过需求、传播与竞争证据筛选真正值得检查的游戏词。

## 配套开源 Skill：Game Trend Site Builder

仓库现在同时提供 [`skills/game-trend-site-builder`](./skills/game-trend-site-builder/)：把已经选中的游戏词进一步变成一个**符合游戏自身视觉风格、可验证真实 iframe、Play-first、可部署的游戏网站**。

它不是固定换皮模板。执行顺序是：

```text
游戏词
  → 找到官方游戏
  → 确认 HTML5 / Browser Build
  → 找到真实运行 iframe
  → 第三方页面实测
  → 研究玩法与官方视觉
  → 针对该游戏重新设计 UI
  → Play + How to Play + Tips + FAQ + SEO
  → 响应式与最终 QA
```

完整说明见 [`SKILL.md`](./skills/game-trend-site-builder/SKILL.md)。

## 核心流程

```text
多来源发现游戏名
  → SEO 搜索意图与实体冲突验证
  → 快速热度验证
     · 24h / 48h 平台扩散
     · 榜单排名变化
     · Google 自动补全新增
     · SERP 新增页面
     · YouTube 视频 / 频道 / 播放量（可选）
  → 独立社媒外溢验证
     · 至少两个平台
     · 至少四个独立创作者
     · 至少一个平台在24小时内仍有新增
  → Google Trends 7天 / 30天 / 90天验证
  → SERP新旧与专站占位验证
  → 30%测试局（test-now）
  → 真实流量验证后再升级为独立站、站内页、观察或淘汰
```

只有通过快速热度层的少量候选才会进入 Google Trends，避免免费 Trends 接口被几百个低质量词占满。

## 自动数据源

- itch.io 最新网页游戏
- itch.io New & Popular
- itch.io New Feed / Featured Feed
- Steam 热门新发行 / 最新独立游戏
- Newgrounds Daily Top Five / 最新通过作品
- CrazyGames、Poki、Y8、GamePix、Lagged 新游戏
- Google Trends 相关上涨查询
- 可配置竞争站 Sitemap / Sitemap Index

## 机会评分与硬门槛

最终机会分采用统一、可解释的权重：

| 信号 | 权重 | 判断重点 |
|---|---:|---|
| 社媒传播速度 | 30% | 多平台、多独立创作者、24小时仍在扩散 |
| Steam／平台增长速度 | 25% | 愿望单名次的近期增速，或24–48小时平台扩散；不是累计总量 |
| 搜索需求形成 | 15% | Trends Rising/Breakout、新词历史与攻略型补全 |
| 内容可扩展性 | 15% | 是否存在至少3个真实攻略主题，能够继续扩成内容集群 |
| SERP空缺 | 10% | 是否确认为新词且没有同名专站／成熟Wiki |
| 名称安全 | 5% | 通用词、重名和非游戏实体冲突风险 |

低搜索结果数量只代表“供给少”，不代表“有人搜”。系统现在把“测试局”和“正式独立站”分成两层：

**`test-now`（30%测试局）**：增长、搜索形成、内容空间、SERP和名称安全达到门槛即可先测；社媒未配置、单平台传播或Provider报错不会把候选直接判死。测试局的目的不是证明它一定成功，而是用最低成本尽快拿到真实水花。

**`independent`（正式独立站）**：仍保留严格硬门槛，缺一项就不能升级：

- 社媒已在至少两个平台、多个独立账号形成外溢传播
- Steam榜单近期上升或刚进入高位榜，而不是只有累计愿望单高
- 搜索需求开始形成，且能规划至少3个真实攻略主题
- 90天历史显示是新词，SERP未被专门站点、同名域名或成熟Wiki占位
- 名称没有明显歧义或其他实体冲突

因此，“高愿望单 + 低结果数”不能直接得到正式独立站推荐；但强增长的新词可以先进入 `test-now`。单个强平台可以提高测试置信度，却仍不足以直接升级为 `independent`。

## 分层验证

### 1. SEO 意图层

检查：

- 主词结果中的游戏占比
- `游戏名 + game play online` 的游戏意图
- 新闻、歌曲、影视、产品等实体冲突
- 自动补全中的游戏长尾和非游戏长尾
- 名称通用度和歧义风险

### 2. 快速热度层

检查：

- 24小时与48小时新增独立来源数量
- 平台榜单当前排名、最佳排名和排名提升
- 自动补全新增游戏长尾数量
- SERP 新增相关页面数量
- 来源是否来自 Trends Rising、Featured、New & Popular 或热门新发行
- YouTube 近7天视频数、不同频道数和播放量（配置 Key 后启用）

快速层分为：

- `pass`：进入 Google Trends
- `watch`：继续观察，不消耗 Trends 请求
- `weak`：热度不足
- `reject`：搜索意图或实体冲突未通过

### 3. 独立传播层

通过 YouTube、Reddit、X、TikTok 的官方接口检查近7天传播。独立站推荐要求跨平台、跨创作者且24小时仍有新增；只有官方账号或单平台爆量不算外溢传播。

Steam/Wiki 候选和在线小游戏都会进入该层，避免 Steam 高愿望单候选绕过传播验证。

### 4. Google Trends 与市场层

同时比较：

- 游戏主词
- `游戏名 + game`
- 基准词 `itch io`
- 最近7天、30天和90天

用于判断：

- 7天或30天持续上涨
- Breakout
- 单日孤立尖峰
- 关键词是否早已存在
- 主词热度是否来自其他实体
- 90天前段是否接近无量，近期才开始上涨
- 是否已有同名域名、专门Wiki或多个攻略站占位

### 5. 站型信号（2026-10-13 加）

依据 `Ship/research/GAME-WIKI-STRUCTURE-2026-10.md`：流量最大的独立游戏站是「首页就是工具」的价值表 / 计算器站；而 codes 词一旦有大媒体覆盖，独立站基本进不去前 10。所以候选再看两件事：

- **🧮 工具需求**（`lib/tool-demand.mjs`，Google Suggest，免费）：查「<游戏> value / values / calculator / trading / stock」，含游戏名且带 value list / calculator / trade / stock 等意图的补全 ≥2 条 = 🧮。算进投入价值「结构」维度（+5），也出现在 Roblox 需求验证表和总报告「今天最值得看」里。结果缓存 24 小时（`data/tool-demand-cache.json`）。
- **codes 媒体进场数**（`lib/codes-media.mjs`，treg `treg.google.serp.organic`，约 $0.00015–0.00055/次）：「<游戏> codes」Google 美国前 10 里，**标题含游戏名**的结果中有几家大媒体（GameRant / Beebom / IGN 等 21 家）。0–1 家 📣 codes 还有窗口（抢速度）· 2 家 🟡 · ≥3 家 ⛔ codes 别当主打（做实体页 / 工具页）。讲这个游戏的结果不到 3 条 = 「SERP 错配」（treg 路由偶尔返回别的游戏），不报 0 家。只查「今天最值得看」的 Roblox / Steam / 联想新词候选，每天最多 15 次新查询，按游戏缓存 3 天（`data/codes-media-cache.json`），花费记在 `data/codes-media-spend.jsonl`。

单查：`node radar.mjs check "游戏名"` 会多出「站型信号」一段；也可以直接 `node lib/tool-demand.mjs "游戏名"`、`node lib/codes-media.mjs "游戏名"`。

### 6. Steam 畅销 / 在玩榜新上榜（2026-10-13 加）

全雷达复盘 `REVIEW-2026-10-12` 的盲区：Dressmaker、Graveyard Keeper 2、The Blood of Dawnwalker 发售后靠口碑冲上畅销榜（Dressmaker 发售第一周全球周畅销 #89 → #12），但原来的 Steam 源只有热门愿望单 / 热门新品 / 最新独立，没有畅销榜和在玩榜，三个都没报过。

`lib/steam-charts-watch.mjs`（每日管线 `scripts/daily.sh` 第 4 步，约 4 分钟，零额度）：

- 榜单（Steam 官方、免费、无 key）：周畅销 全球 / 美 / 德 / 日（`IStoreTopSellersService/GetWeeklyTopSellers`，自带上周名次，可按 `start_date` 查历史周）、在玩榜（`ISteamChartsService/GetMostPlayedGames`）、实时畅销 美 / 德 / 日（商店搜索 `filter=topsellers`）。各取前 100。`GetTopReleasesPages` 停在 2025-02，不用。
- 每天把名次记进 `data/steam-charts-state.json`；前 14 天都不在前 100 = 🆕，比上次升 ≥30 名 = ⬆️。只报**发售 ≤45 天或 7 天内发售**的（名字 / 发售日 / 标签用 `IStoreBrowseService/GetItems` 批量拿，缓存 7 天），常青游戏进不来。
- 🟢 冲榜 = 有一个榜进前 50 且发售 ≤30 天（或 7 天内发售的预购）· 🌱 上榜 = 其余。每条带新注册域名（`lib/nrd.mjs`）、🧮 工具需求（前 12 个）、投入价值（🟢 前 5 个，`lib/invest-score.mjs` 原样调用，管线 3 天内评过的直接用）。
- 报告 `../RADAR-STEAMCHARTS-<日期>.md`；总报告「今天最值得看」只收当天第一次报的 🟢（周榜一周内每天是同一份数据），投入价值 ❌ 的不收。
- ⚠️ 周畅销滞后约一周（统计周从周二开始），实时畅销补这一周，但第一次运行只建基线。

```bash
node lib/steam-charts-watch.mjs                    # 跑一轮，写报告和状态
node lib/steam-charts-watch.mjs --dry-run          # 只打印
node lib/steam-charts-watch.mjs --week=2026-09-22  # 回测那一周的周畅销（不写任何东西）
```

## GitHub Actions

`.github/workflows/radar.yml` 默认在每小时第17分和第47分运行。旧任务会在新任务开始时自动取消，只保留最新扫描。

工作流会：

1. 抓取全部自动数据源
2. 更新来源首次发现时间和榜单排名
3. 每轮最多验证50个SEO候选
4. 计算全部当前候选的快速热度
5. 只把快速层通过的候选送入 Google Trends
6. 提交 `data/state.json`、`data/candidates.json` 和 `data/latest-report.json`

## 可选 YouTube 验证

YouTube 验证默认关闭，不影响其他功能。

需要启用时，在 GitHub 仓库中添加 Actions Secret：

```text
YOUTUBE_API_KEY
```

启用后，每轮最多验证3个高优先级候选，获取近7天：

- 视频数量
- 不同频道数量
- 总播放量
- 最近24小时视频数量

未设置 Secret 时，系统会自动跳过 YouTube，不会报错。

## 本地运行

```bash
npm install
npm test
npm run scan
```

前端本地预览：

```bash
npm install -g vercel
vercel dev
```

## 添加竞争站 Sitemap

在 `config/sources.json` 中加入：

```json
{
  "id": "competitor-example",
  "name": "Example Games Sitemap",
  "url": "https://example.com/game-sitemap.xml",
  "kind": "competitor-sitemap",
  "fetchKind": "sitemap",
  "enabled": true,
  "baselineOnly": true
}
```

首次运行只建立基线，第二次开始识别新增 URL。

## Vercel 部署

1. 在 Vercel 导入 GitHub 仓库
2. Framework Preset 选择 `Other`
3. 不需要 Build Command
4. 部署

前端直接读取 GitHub 中的最新结果数据，因此自动扫描更新数据时不需要重新部署页面。

## 数据文件

- `data/state.json`：来源快照、URL和榜单位置
- `data/candidates.json`：候选、SEO、快速热度、YouTube和Trends结果
- `data/latest-report.json`：最近一次扫描统计

## 合规提醒

本工具只发现公开页面与名称。将第三方游戏 iframe 到独立站之前，应确认开发者授权、嵌入条款、素材使用权限和广告许可。
