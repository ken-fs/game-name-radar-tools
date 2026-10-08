import assert from "node:assert/strict";
import { test } from "node:test";

import { classifySubkeywords, combine } from "../lib/roblox-demand-scan.mjs";
import { renderReport } from "../lib/meme-game-watch.mjs";

// 2026-10-08：Drop a Fruit 因游戏名含 fruit，玩法词被全量误判成攻略词（虚报 guide-rich 10 条）
test("游戏名撞攻略词时，玩法词不再算攻略词", () => {
  const s = classifySubkeywords("Drop a Fruit", [
    "drop a fruit code",
    "drop fruit duos",
    "drop fruit that has come across",
    "drop fruit sailor piece",
  ]);
  assert.equal(s.verdict, "guide-some");
  assert.deepEqual(s.guide, ["drop a fruit code"]);
});

test("移除 fruit 后，真攻略词仍被识别（不误伤）", () => {
  const s = classifySubkeywords("Blox Fruits", [
    "blox fruits codes",
    "blox fruits tier list",
    "blox fruits fruit tier list",
  ]);
  assert.equal(s.verdict, "guide-rich");
});

// 2026-10-08：Trends 形状是相对值，零量词也会显示 rising——量级是第三道否决
test("量级低于锚点 1% 时否决，但按峰值比估（不可靠）时不否决", () => {
  const trends = { shape: "rising" };
  const sub = { verdict: "guide-rich" };
  assert.match(combine(trends, sub, { ok: true, ratio: 0.003, basis: "recent" }).decision, /放弃/);
  assert.match(combine(trends, sub, { ok: true, ratio: 0.003, basis: "peak" }).decision, /GO/);
  assert.match(combine(trends, sub, { ok: true, ratio: 0.54, basis: "recent" }).decision, /GO/);
  // 量级未测时不介入判决（原本的双源规则照旧）
  assert.match(combine(trends, sub, null).decision, /GO/);
});

// 2026-10-08：amitabh bachchan / sud ouest 是地区热搜（影星、地名），不是网友梗
test("梗报告把地区热搜来源标为未确认", () => {
  const rows = [
    {
      name: "sud ouest",
      source: "trends-fr",
      verdict: "alert",
      hits: 2,
      counts: { FR: 2 },
      prev: 0,
      firstSeen: "2026-10-08T00:00:00Z",
      lastPlayable: ["jeux sud ouest gratuit en ligne"],
      link: "",
    },
  ];
  const rep = renderReport(rows, "2026-10-08", {});
  assert.match(rep, /🚨 冒头 ⚠️/);
  assert.match(rep, /热搜，未确认是梗/);
  assert.match(rep, /其中 1 个来自地区热搜/);
});

test("kym / manual 来源的冒头不加未确认标记", () => {
  const rows = [
    {
      name: "tung tung sahur",
      source: "kym",
      verdict: "alert",
      hits: 3,
      counts: { US: 3 },
      prev: 0,
      firstSeen: "2026-10-08T00:00:00Z",
      lastPlayable: ["tung tung sahur game"],
      link: "",
    },
  ];
  const rep = renderReport(rows, "2026-10-08", {});
  assert.doesNotMatch(rep, /未确认是梗/);
});
