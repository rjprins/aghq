/**
 * Tests for completeDirectoryPath — the directory completion behind the
 * launch dialog's project path field (/api/complete-path).
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { completeDirectoryPath } from "../src/server/utils.js";

describe("completeDirectoryPath", () => {
  let base: string;

  beforeAll(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), "agmux-complete-"));
    await fs.mkdir(path.join(base, "projects"));
    await fs.mkdir(path.join(base, "proto"));
    await fs.mkdir(path.join(base, "docs"));
    await fs.mkdir(path.join(base, ".hidden"));
    await fs.writeFile(path.join(base, "profile.txt"), "");
  });

  afterAll(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  test("completes directories matching the fragment, excluding files", async () => {
    const out = await completeDirectoryPath(path.join(base, "pro"));
    expect(out).toEqual([path.join(base, "projects"), path.join(base, "proto")]);
  });

  test("matching is case-insensitive", async () => {
    const out = await completeDirectoryPath(path.join(base, "PRO"));
    expect(out).toEqual([path.join(base, "projects"), path.join(base, "proto")]);
  });

  test("trailing slash lists all visible child directories", async () => {
    const out = await completeDirectoryPath(`${base}/`);
    expect(out).toEqual([
      path.join(base, "docs"),
      path.join(base, "projects"),
      path.join(base, "proto"),
    ]);
  });

  test("hidden directories only appear when the fragment starts with a dot", async () => {
    expect(await completeDirectoryPath(`${base}/`)).not.toContain(path.join(base, ".hidden"));
    expect(await completeDirectoryPath(path.join(base, ".h"))).toEqual([path.join(base, ".hidden")]);
  });

  test("nonexistent parent directory yields no completions", async () => {
    expect(await completeDirectoryPath(path.join(base, "nope", "x"))).toEqual([]);
  });

  test("empty and relative prefixes yield no completions", async () => {
    expect(await completeDirectoryPath("")).toEqual([]);
    expect(await completeDirectoryPath("   ")).toEqual([]);
    expect(await completeDirectoryPath("projects/su")).toEqual([]);
  });

  test("results are capped at the limit", async () => {
    const out = await completeDirectoryPath(`${base}/`, 2);
    expect(out).toEqual([path.join(base, "docs"), path.join(base, "projects")]);
  });

  test("tilde prefixes complete against the home directory and keep tilde notation", async () => {
    const homeTemp = await fs.mkdtemp(path.join(os.homedir(), ".agmux-complete-test-"));
    try {
      await fs.mkdir(path.join(homeTemp, "subdir"));
      const rel = path.relative(os.homedir(), homeTemp);
      const out = await completeDirectoryPath(`~/${rel}/su`);
      expect(out).toEqual([`~/${rel}/subdir`]);
    } finally {
      await fs.rm(homeTemp, { recursive: true, force: true });
    }
  });

  test("bare tilde completes the home directory's children", async () => {
    const out = await completeDirectoryPath("~");
    for (const completion of out) {
      expect(completion.startsWith("~/")).toBe(true);
    }
  });
});
