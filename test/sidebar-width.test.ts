import { describe, expect, test } from "vitest";
import {
  adjustSidebarWidth,
  maxSidebarWidthForViewport,
  normalizeSidebarWidth,
  parseStoredSidebarWidth,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from "../src/ui/sidebar-width.js";

describe("sidebar width helpers", () => {
  test("normalizes invalid and out-of-range widths", () => {
    expect(normalizeSidebarWidth(Number.NaN)).toBe(SIDEBAR_WIDTH_DEFAULT);
    expect(normalizeSidebarWidth(120)).toBe(SIDEBAR_WIDTH_MIN);
    expect(normalizeSidebarWidth(900)).toBe(SIDEBAR_WIDTH_MAX);
    expect(normalizeSidebarWidth(311.6)).toBe(312);
  });

  test("keeps enough room for the terminal on narrower desktop viewports", () => {
    expect(maxSidebarWidthForViewport(900)).toBe(540);
    expect(normalizeSidebarWidth(560, 900)).toBe(540);
    expect(maxSidebarWidthForViewport(520)).toBe(SIDEBAR_WIDTH_MIN);
  });

  test("parses stored widths only when numeric", () => {
    expect(parseStoredSidebarWidth(null)).toBeNull();
    expect(parseStoredSidebarWidth("")).toBeNull();
    expect(parseStoredSidebarWidth("not-a-number")).toBeNull();
    expect(parseStoredSidebarWidth("320")).toBe(320);
  });

  test("adjusts a width by keyboard-sized steps within the same bounds", () => {
    expect(adjustSidebarWidth(280, -80)).toBe(SIDEBAR_WIDTH_MIN);
    expect(adjustSidebarWidth(552, 16)).toBe(SIDEBAR_WIDTH_MAX);
  });
});
