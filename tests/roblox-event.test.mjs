import { test } from "node:test";
import assert from "node:assert/strict";
import { endDateFrom, eventNote } from "../lib/roblox-event.mjs";

test("endDateFrom takes the latest date in the description", () => {
  const d = endDateFrom("Starts October 13. If you are still there on October 31, you will not be alone.", "2026-10-13T21:53:05Z");
  assert.equal(d.toISOString().slice(0, 10), "2026-10-31");
});

test("endDateFrom rolls a January date into next year for a December launch", () => {
  assert.equal(endDateFrom("Runs until Jan. 5th", "2026-12-20").toISOString().slice(0, 10), "2027-01-05");
});

test("endDateFrom returns null when no date is written", () => {
  assert.equal(endDateFrom("Go back through 20 years of Roblox", "2026-09-20"), null);
});

test("eventNote reports the end date or the The Hunt fallback", () => {
  const ev = { group: "Roblox Presents", endsAt: new Date("2026-10-31T00:00:00Z"), daysLeft: 8 };
  assert.equal(eventNote(ev, { short: true }), "⏳ 官方限时活动 · 截止 10-31（剩 8 天）");
  assert.match(eventNote({ ...ev, endsAt: null, daysLeft: null }, { short: true }), /截止日没写/);
});
