import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanRobloxName, parseDemand, parseGrowth, parseMismatch } from "../radar.mjs";

test("cleanRobloxName strips update tags and emoji", () => {
  assert.equal(cleanRobloxName("[🐟UPDATE] Hole Fishing"), "Hole Fishing");
  assert.equal(cleanRobloxName("🎃 [HALLOWEEN EVENT] FNaF World Multiplaye"), "FNaF World Multiplaye");
  assert.equal(cleanRobloxName("Anime Zero [FLAME DIRECTOR] 🔥👻"), "Anime Zero");
  assert.equal(cleanRobloxName("Run a Sari-Sari Store!"), "Run a Sari-Sari Store");
  assert.equal(cleanRobloxName("+1 Assassin Leveling"), "Assassin Leveling");
});

test("parseGrowth reads the growth-scan table", () => {
  const rows = parseGrowth(
    "  增长比   CCU     日访问估  年龄   更新     游戏\n" +
      "   33.3x    4698     282K   156天    0天前  [🛒] Run a Sari-Sari Store!  [10126644530]\n" +
      "   13.3x   18371    1102K    84天    0天前  Anime Zero [FLAME DIRECTOR] 🔥👻  [10512942223]\n",
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { ageDays: 156, ccu: 4698, growth: 33.3, id: "10126644530", name: "[🛒] Run a Sari-Sari Store!", updatedDaysAgo: 0 });
});

test("parseMismatch keeps the fishing-rod flags", () => {
  const rows = parseMismatch("  🎣🎣   3.2       7     12,400    3109  [🐟UPDATE] Hole Fishing  [9906378607]\n  🎣   1.1  3  800  900  Foo  [1]\n");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].flag, "🎣🎣");
  assert.equal(rows[0].channels, 7);
  assert.equal(rows[0].ratio, 3.2);
});

test("parseDemand pulls verdicts per game", () => {
  const rows = parseDemand(
    "── Drop a Fruit\n   Trends(codes): 形状=rising · 峰值 100\n   子关键词: guide-rich  攻略词[10]\n   判决: 🟢 GO — Trends 上升/高位稳住 + 子关键词含攻略词（双源确认）\n" +
      "── Run a Sari-Sari Store\n   判决: 🟡 观察 — Trends 未取到数据（可能限频）\n",
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].verdict, "🟢 GO");
  assert.match(rows[0].trend, /rising/);
  assert.equal(rows[1].verdict, "🟡 观察");
});

test("parseDemand marks plain 放弃 with an icon", () => {
  const rows = parseDemand("── Foo\n   判决: 放弃 — Trends 一座尖峰后掉头，且无攻略长尾，短命热度\n");
  assert.equal(rows[0].verdict, "❌ 放弃");
});
