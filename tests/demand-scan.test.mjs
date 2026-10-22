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

// 2026-10-22：三源规则——Trends 永远不能单独判死（它对 Roblox 长尾的分辨率是 0/1，
// 自家最能赚的 hole fishing 在 Trends 上 candMax=1，旧规则会把它判死）
test("量级低于锚点 1%：联想还有攻略词就不判死", () => {
  const trends = { shape: "rising" };
  assert.match(combine(trends, { verdict: "guide-rich" }, { ok: true, ratio: 0.003, basis: "recent" }).decision, /GO/);
  assert.match(combine(trends, { verdict: "guide-rich" }, { ok: true, ratio: 0.003, basis: "peak" }).decision, /GO/);
  assert.match(combine(trends, { verdict: "guide-rich" }, { ok: true, ratio: 0.54, basis: "recent" }).decision, /GO/);
  assert.match(combine(trends, { verdict: "guide-rich" }, null).decision, /GO/);
});

test("量级低于锚点 1%：联想没攻略词时，媒体没查全只观察、媒体 0 家才放弃", () => {
  const noSub = { verdict: "empty" };
  const mag = { ok: true, ratio: 0.002, basis: "recent" };
  assert.match(combine({ shape: "no-data" }, noSub, mag, null).decision, /观察/);
  assert.match(combine({ shape: "no-data" }, noSub, mag, { verdict: "open", media: [] }).decision, /放弃/);
  assert.match(combine({ shape: "no-data" }, noSub, mag, { verdict: "mixed", media: ["a.com", "b.com"] }).decision, /观察/);
  // 低刻度（候选 ≤1、锚点 ≥4）时比例只是上界，不能否决
  assert.match(combine({ shape: "no-data" }, { verdict: "mixed" }, { ...mag, lowResolution: true }, { verdict: "open", media: [] }).decision, /观察/);
});

test("三条同时无量才放弃；媒体写过 codes 就是有人搜（观察，不判死）", () => {
  assert.match(combine({ shape: "no-volume" }, { verdict: "empty" }, null, { verdict: "open", media: [] }).decision, /放弃/);
  assert.match(combine({ shape: "no-volume" }, { verdict: "empty" }, null, { verdict: "mixed", media: ["a.com", "b.com"] }).decision, /观察/);
  // 媒体没查全（被挡 / 请求失败）不能判死
  assert.match(combine({ shape: "no-volume" }, { verdict: "empty" }, null, null).decision, /观察/);
  assert.match(combine({ shape: "spike" }, { verdict: "empty" }, null, { verdict: "unverified", media: [], blocked: ["x.com", "y.com"] }).decision, /观察/);
  assert.match(combine({ shape: "spike" }, { verdict: "empty" }, null, { verdict: "open", media: [] }).decision, /放弃/);
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

// 2026-10-22：名字归因闸门——联想里一条含游戏名的补全都没有
test("联想里没有整词含游戏名 + 媒体 0 家 + Trends 没起量 = 名字归因失败（Merge Block Arena）", () => {
  const unnamed = { verdict: "mixed", attributed: false };   // 拿到的是 merge block app / merge arena build
  const empty = { verdict: "empty", attributed: false };
  const named = { verdict: "guide-rich", attributed: true };
  const open = { verdict: "open", media: [] };
  assert.match(combine({ shape: "no-data" }, unnamed, null, open).decision, /放弃/);
  assert.match(combine({ shape: "no-data" }, empty, null, open).decision, /放弃/);
  assert.match(combine({ shape: "no-data" }, named, null, open).decision, /观察/);
  // Trends 起量 = 只是联想还没收录，不判死
  assert.match(combine({ shape: "high-stable" }, unnamed, null, open).decision, /观察/);
  assert.match(combine({ shape: "rising" }, unnamed, null, open).decision, /观察/);
  // 媒体真写了 codes = 有人搜，不判死
  assert.match(combine({ shape: "no-data" }, unnamed, null, { verdict: "mixed", media: ["a.com", "b.com"] }).decision, /观察/);
  // 媒体没查全时不判死
  assert.match(combine({ shape: "no-data" }, unnamed, null, null).decision, /观察/);
});

test("联想两次都请求失败 ≠ 名字不存在（不能判死）", () => {
  const failedSub = { verdict: "empty", attributed: false, failed: true };
  assert.match(combine({ shape: "no-data" }, failedSub, null, { verdict: "open", media: [] }).decision, /观察/);
});

test("补全里有整词游戏名才算归因成功（hole fishing codes 算，merge block app 不算）", () => {
  const ok = classifySubkeywords("Hole Fishing", ["hole fishing codes", "hole fishing roblox codes", "hole fishing script no key"]);
  assert.equal(ok.attributed, true);
  assert.equal(ok.verdict, "guide-rich");
  const no = classifySubkeywords("Merge Block Arena", ["merge block app", "merge block games", "merge arena build"]);
  assert.equal(no.attributed, false);
});
