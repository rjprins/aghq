import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SqliteStore } from "../src/persist/sqlite.js";
import type { AgentSessionRecord } from "../src/persist/sqlite.js";

const REPO = "/repo";

function agentSession(overrides: Partial<AgentSessionRecord>): AgentSessionRecord {
  return {
    provider: "claude",
    providerSessionId: "sess",
    name: "session",
    nameSource: "derived",
    command: "claude",
    args: [],
    cwd: null,
    cwdSource: "log",
    createdAt: 1_000,
    lastSeenAt: 1_000,
    lastRestoredAt: null,
    ...overrides,
  };
}

describe("SqliteStore worktrees", () => {
  let tmpRoot: string | null = null;

  async function makeStore(): Promise<SqliteStore> {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agmux-worktrees-"));
    return new SqliteStore(path.join(tmpRoot, "wt.db"));
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    if (tmpRoot) {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      tmpRoot = null;
    }
  });

  test("upsert inserts then updates, keeping first_seen_at and first non-null origin", async () => {
    const store = await makeStore();
    const wt = "/repo/.worktrees/feat-a";

    vi.spyOn(Date, "now").mockReturnValue(111);
    const id1 = store.upsertWorktreeObservation({
      repoRoot: REPO,
      path: wt,
      branch: "feat/a",
      state: "active",
      stateDetail: { head: "abc" },
      scannedAt: 1_000,
      origin: "agmux",
    });

    vi.spyOn(Date, "now").mockReturnValue(222);
    const id2 = store.upsertWorktreeObservation({
      repoRoot: REPO,
      path: wt,
      branch: "feat/a-renamed",
      state: "merged",
      stateDetail: { head: "def" },
      scannedAt: 2_000,
      origin: "oob",
    });

    expect(id2).toBe(id1);
    const row = store.getWorktreeRowByPath(REPO, wt);
    expect(row?.first_seen_at).toBe(111);
    expect(row?.branch).toBe("feat/a-renamed");
    expect(row?.state).toBe("merged");
    expect(row?.scanned_at).toBe(2_000);
    expect(row?.origin).toBe("agmux"); // origin only fills when null
    expect(JSON.parse(row?.state_detail ?? "null")).toEqual({ head: "def" });
  });

  test("tombstone frees the partial unique index for a new live row at the same path", async () => {
    const store = await makeStore();
    const wt = "/repo/.worktrees/feat-b";

    const id1 = store.upsertWorktreeObservation({
      repoRoot: REPO,
      path: wt,
      branch: "feat/b",
      state: "merged",
      stateDetail: null,
      scannedAt: 1_000,
    });
    store.tombstoneWorktree(REPO, wt, {
      state: "merged",
      reapEvidence: "PR !1 completed",
      salvagePath: null,
      atticTag: "attic/feat-b",
    });

    const id2 = store.upsertWorktreeObservation({
      repoRoot: REPO,
      path: wt,
      branch: "feat/b2",
      state: "active",
      stateDetail: null,
      scannedAt: 2_000,
    });

    expect(id2).not.toBe(id1);
    expect(store.getWorktreeRowByPath(REPO, wt)?.id).toBe(id2);
    expect(store.listWorktreeRows(REPO)).toHaveLength(1);
    const all = store.listWorktreeRows(REPO, { includeTombstones: true });
    expect(all).toHaveLength(2);
    const dead = all.find((r) => r.id === id1);
    expect(dead?.reaped_at).not.toBeNull();
    expect(dead?.reap_evidence).toBe("PR !1 completed");
    expect(dead?.attic_tag).toBe("attic/feat-b");
  });

  test("moveWorktreePath appends prior_paths on a plain move", async () => {
    const store = await makeStore();
    const oldPath = "/repo/.worktrees/old-name";
    const newPath = "/repo/.worktrees/new-name";

    const id = store.upsertWorktreeObservation({
      repoRoot: REPO,
      path: oldPath,
      branch: "feat/c",
      state: "open",
      stateDetail: null,
      scannedAt: 1_000,
    });
    store.moveWorktreePath(REPO, oldPath, newPath);

    expect(store.getWorktreeRowByPath(REPO, oldPath)).toBeUndefined();
    const row = store.getWorktreeRowByPath(REPO, newPath);
    expect(row?.id).toBe(id);
    expect(JSON.parse(row?.prior_paths ?? "[]")).toEqual([oldPath]);
  });

  test("moveWorktreePath merges a duplicate live row at the target path", async () => {
    const store = await makeStore();
    const oldPath = "/repo/.worktrees/dup-old";
    const newPath = "/repo/.worktrees/dup-new";

    vi.spyOn(Date, "now").mockReturnValue(100);
    const movedId = store.upsertWorktreeObservation({
      repoRoot: REPO,
      path: oldPath,
      branch: "feat/d",
      state: "open",
      stateDetail: null,
      scannedAt: 1_000,
    });
    store.setWorktreeMeta(REPO, oldPath, { label: "the label" });

    vi.spyOn(Date, "now").mockReturnValue(200);
    store.upsertWorktreeObservation({
      repoRoot: REPO,
      path: newPath,
      branch: "feat/d",
      state: "open",
      stateDetail: null,
      scannedAt: 2_000,
    });
    store.setWorktreeMeta(REPO, newPath, { ticketId: "T-42" });

    store.moveWorktreePath(REPO, oldPath, newPath);

    const rows = store.listWorktreeRows(REPO, { includeTombstones: true });
    expect(rows).toHaveLength(1); // duplicate deleted
    const row = rows[0];
    expect(row.id).toBe(movedId);
    expect(row.path).toBe(newPath);
    expect(row.first_seen_at).toBe(100); // oldest wins
    expect(row.label).toBe("the label"); // non-null preferred
    expect(row.ticket_id).toBe("T-42"); // non-null preferred
    expect(JSON.parse(row.prior_paths ?? "[]")).toEqual([oldPath]);
  });

  test("setWorktreePrProofByBranch merges into existing state_detail JSON", async () => {
    const store = await makeStore();
    const wt = "/repo/.worktrees/feat-e";

    store.upsertWorktreeObservation({
      repoRoot: REPO,
      path: wt,
      branch: "feat/e",
      state: "open",
      stateDetail: { head: "abc123", stack: "feat" },
      scannedAt: 1_000,
    });
    store.setWorktreePrProofByBranch(REPO, "feat/e", {
      prId: "4812",
      prTitle: "Add thing",
      prStatus: "completed",
      mergeSourceSha: "abc123",
      prCompletedAt: 5_000,
    });

    const row = store.getWorktreeRowByPath(REPO, wt);
    expect(row?.pr_id).toBe("4812");
    expect(row?.pr_title).toBe("Add thing");
    expect(JSON.parse(row?.state_detail ?? "null")).toEqual({
      head: "abc123",
      stack: "feat",
      prStatus: "completed",
      mergeSourceSha: "abc123",
      prCompletedAt: 5_000,
    });
  });

  test("agentSessionContextForPath matches exact cwd and nested prefixes only", async () => {
    const store = await makeStore();
    const wt = "/repo/.worktrees/a";

    store.upsertAgentSession(agentSession({
      providerSessionId: "s1",
      name: "first",
      cwd: wt,
      createdAt: 1_000,
      lastSeenAt: 5_000,
    }));
    store.upsertAgentSession(agentSession({
      providerSessionId: "s2",
      name: "second",
      cwd: `${wt}/sub/dir`,
      createdAt: 2_000,
      lastSeenAt: 9_000,
    }));
    // Sibling that shares a string prefix but not a path prefix: must not match.
    store.upsertAgentSession(agentSession({
      providerSessionId: "s3",
      name: "sibling",
      cwd: "/repo/.worktrees/abc",
      createdAt: 500,
      lastSeenAt: 99_000,
    }));

    const ctx = store.agentSessionContextForPath([wt]);
    expect(ctx).toEqual({
      sessionCount: 2,
      earliestName: "first",
      earliestCreatedAt: 1_000,
      lastSeenAt: 9_000,
    });

    // Prior paths widen the match set.
    const withPrior = store.agentSessionContextForPath(["/nowhere", "/repo/.worktrees/abc"]);
    expect(withPrior.sessionCount).toBe(1);
    expect(withPrior.earliestName).toBe("sibling");

    expect(store.agentSessionContextForPath([])).toEqual({
      sessionCount: 0,
      earliestName: null,
      earliestCreatedAt: null,
      lastSeenAt: null,
    });
  });

  test("insertWorktreeTombstoneIfMissing inserts once and skips any existing row", async () => {
    const store = await makeStore();
    const gone = "/repo/.worktrees/long-gone";

    const inserted = store.insertWorktreeTombstoneIfMissing({
      repoRoot: REPO,
      path: gone,
      branch: "feat/old",
      label: "old work",
      reapEvidence: "backfilled from reflog",
      origin: "backfill",
      reapedAt: 42_000,
    });
    expect(inserted).toBe(true);

    const again = store.insertWorktreeTombstoneIfMissing({
      repoRoot: REPO,
      path: gone,
      branch: "feat/old",
      reapEvidence: "backfilled twice",
      origin: "backfill",
      reapedAt: 43_000,
    });
    expect(again).toBe(false);

    const rows = store.listWorktreeRows(REPO, { includeTombstones: true });
    expect(rows).toHaveLength(1);
    expect(rows[0].reaped_at).toBe(42_000);
    expect(rows[0].first_seen_at).toBe(42_000);
    expect(rows[0].origin).toBe("backfill");
    expect(rows[0].label).toBe("old work");

    // A live row at the path also blocks backfill.
    const live = "/repo/.worktrees/still-here";
    store.upsertWorktreeObservation({
      repoRoot: REPO,
      path: live,
      branch: "feat/live",
      state: "active",
      stateDetail: null,
      scannedAt: 1_000,
    });
    expect(store.insertWorktreeTombstoneIfMissing({
      repoRoot: REPO,
      path: live,
      branch: "feat/live",
      reapEvidence: "should not insert",
      origin: "backfill",
      reapedAt: 50_000,
    })).toBe(false);
    expect(store.listWorktreeRows(REPO, { includeTombstones: true })).toHaveLength(2);
  });
});
