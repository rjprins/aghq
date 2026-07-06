import { describe, expect, test } from "vitest";
import { historyNeedle, InputAnchorStore, locateInLines } from "../src/server/history-scroll.js";

describe("historyNeedle", () => {
  test("takes the first line and compacts whitespace", () => {
    expect(historyNeedle("run  the\tthing\nsecond line")).toBe("run the thing");
  });

  test("drops the truncation ellipsis", () => {
    expect(historyNeedle("do the long thing...")).toBe("do the long thing");
  });

  test("caps at a word boundary", () => {
    const long = "word ".repeat(30).trim();
    const needle = historyNeedle(long);
    expect(needle.length).toBeLessThanOrEqual(60);
    expect(needle.endsWith("word")).toBe(true);
  });

  test("empty input yields empty needle", () => {
    expect(historyNeedle("   \n  ")).toBe("");
  });
});

describe("locateInLines", () => {
  const lines = [
    "[user@host]$ echo hello", // line 100
    "hello", // 101
    "[user@host]$ ls -la", // 102
    "total 0", // 103
    "❯ echo hello", // 104
    "hello", // 105
  ];

  test("finds a match and returns its absolute line", () => {
    expect(locateInLines(lines, 100, "ls -la", null)).toBe(102);
  });

  test("prefers the occurrence closest to the estimate", () => {
    expect(locateInLines(lines, 100, "echo hello", 99)).toBe(100);
    expect(locateInLines(lines, 100, "echo hello", 105)).toBe(104);
  });

  test("falls back to the most recent occurrence without an estimate", () => {
    expect(locateInLines(lines, 100, "echo hello", null)).toBe(104);
  });

  test("matches case-insensitively as a fallback", () => {
    expect(locateInLines(lines, 100, "ECHO HELLO", null)).toBe(104);
  });

  test("matches across extra whitespace in the pane", () => {
    expect(locateInLines(["❯   echo    hello"], 7, "echo hello", null)).toBe(7);
  });

  test("returns null when nothing matches", () => {
    expect(locateInLines(lines, 100, "not present", null)).toBeNull();
  });
});

describe("InputAnchorStore", () => {
  test("returns the anchor closest in time to ts", () => {
    const store = new InputAnchorStore();
    store.record("p1", { ts: 1000, line: 10 });
    store.record("p1", { ts: 2000, line: 20 });
    store.record("p1", { ts: 3000, line: 30 });
    expect(store.closestTo("p1", 2200)).toEqual({ ts: 2000, line: 20 });
    expect(store.closestTo("p1", 2900)).toEqual({ ts: 3000, line: 30 });
  });

  test("rapid successive submits resolve to their own anchors", () => {
    const store = new InputAnchorStore();
    store.record("p1", { ts: 1000, line: 10 });
    store.record("p1", { ts: 1400, line: 40 }); // 400ms later
    expect(store.closestTo("p1", 1050)).toEqual({ ts: 1000, line: 10 });
    expect(store.closestTo("p1", 1390)).toEqual({ ts: 1400, line: 40 });
  });

  test("returns null beyond the max time delta", () => {
    const store = new InputAnchorStore();
    store.record("p1", { ts: 1000, line: 10 });
    expect(store.closestTo("p1", 1000 + 16_000)).toBeNull();
    expect(store.closestTo("p2", 1000)).toBeNull();
  });

  test("caps stored anchors per pty", () => {
    const store = new InputAnchorStore();
    for (let i = 0; i < 250; i++) store.record("p1", { ts: i * 1000, line: i });
    // Oldest 50 evicted: ts 10s is now 40s away from the earliest kept anchor.
    expect(store.closestTo("p1", 10_000)).toBeNull();
    expect(store.closestTo("p1", 50_000)).toEqual({ ts: 50_000, line: 50 });
    expect(store.closestTo("p1", 249_000)).toEqual({ ts: 249_000, line: 249 });
  });

  test("clear removes a pty's anchors", () => {
    const store = new InputAnchorStore();
    store.record("p1", { ts: 1000, line: 10 });
    store.clear("p1");
    expect(store.closestTo("p1", 1000)).toBeNull();
  });
});
